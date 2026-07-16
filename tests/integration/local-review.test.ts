import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runLocalReview } from "../../src/workflows/local-review.js";

const execFileAsync = promisify(execFile);
let fixture: Awaited<ReturnType<typeof createRepositoryFixture>>;

beforeAll(async () => {
  fixture = await createRepositoryFixture();
});

afterAll(async () => {
  await rm(fixture.root, { recursive: true, force: true });
});

describe("local review workflow", () => {
  it("runs the complete pipeline and keeps only exact-diff findings", async () => {
    let worktreePath = "";
    let outputPath = "";

    const result = await runLocalReview(
      workflowOptions(fixture),
      {
        runCodex: async (options) => {
          worktreePath = options.worktreePath;
          outputPath = options.outputPath;
          await access(worktreePath);
          expect(options.prompt).toContain(`Base SHA: ${fixture.baseSha}`);
          expect(options.prompt).toContain(`Head SHA: ${fixture.headSha}`);
          expect(options.reasoningEffort).toBe("high");
          expect(path.relative(worktreePath, options.schemaPath)).toMatch(/^\.\./);

          return {
            findings: [
              {
                title: "Changed line finding",
                body: "This points to a changed right-side line.",
                priority: 1,
                confidence: 0.95,
                path: "src/app.ts",
                start_line: 2,
                end_line: 2,
              },
              {
                title: "Unchanged line finding",
                body: "This must not be published.",
                priority: 2,
                confidence: 0.8,
                path: "src/app.ts",
                start_line: 3,
                end_line: 3,
              },
            ],
            summary: "One accepted and one rejected finding.",
          };
        },
      },
    );

    expect(result).toEqual({
      repository: "example/project",
      pull_request_number: 7,
      base_sha: fixture.baseSha,
      head_sha: fixture.headSha,
      review: {
        findings: [
          expect.objectContaining({
            title: "Changed line finding",
            path: "src/app.ts",
            start_line: 2,
          }),
        ],
        summary: "One accepted and one rejected finding.",
      },
      rejected_findings: [
        {
          title: "Unchanged line finding",
          path: "src/app.ts",
          start_line: 3,
          end_line: 3,
          reason: "path-or-line-range-not-in-reviewed-diff",
        },
      ],
    });
    await expect(access(worktreePath)).rejects.toThrow();
    await expect(access(outputPath)).rejects.toThrow();
  });

  it("cleans up the worktree when Codex fails", async () => {
    let worktreePath = "";

    await expect(
      runLocalReview(workflowOptions(fixture), {
        runCodex: async (options) => {
          worktreePath = options.worktreePath;
          throw new Error("simulated Codex failure");
        },
      }),
    ).rejects.toThrow(/simulated Codex failure/);

    await expect(access(worktreePath)).rejects.toThrow();
  });
});

function workflowOptions(repositoryFixture: typeof fixture): {
  fixture: unknown;
  dataDirectory: string;
  model: string;
  reasoningEffort: "high";
  timeoutMs: number;
  schemaPath: string;
  instructionsPath: string;
  remoteUrlOverride: string;
} {
  return {
    fixture: {
      action: "opened",
      number: 7,
      repository: {
        full_name: "example/project",
        clone_url: "https://github.com/example/project.git",
      },
      pull_request: {
        state: "open",
        draft: false,
        base: {
          ref: "main",
          sha: repositoryFixture.baseSha,
          repo: { full_name: "example/project" },
        },
        head: {
          sha: repositoryFixture.headSha,
          repo: { full_name: "example/project" },
        },
      },
    },
    dataDirectory: repositoryFixture.dataPath,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    timeoutMs: 60_000,
    schemaPath: fileURLToPath(
      new URL("../../src/codex/review-schema.json", import.meta.url),
    ),
    instructionsPath: fileURLToPath(
      new URL("../../src/codex/review-instructions.md", import.meta.url),
    ),
    remoteUrlOverride: repositoryFixture.sourcePath,
  };
}

async function createRepositoryFixture(): Promise<{
  root: string;
  sourcePath: string;
  dataPath: string;
  baseSha: string;
  headSha: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "auto-agent-workflow-"));
  const sourcePath = path.join(root, "source repo");
  const dataPath = path.join(root, "data");
  await mkdir(sourcePath);
  await mkdir(dataPath);
  await git(sourcePath, ["init", "--initial-branch=main"]);
  await git(sourcePath, ["config", "user.name", "Test User"]);
  await git(sourcePath, ["config", "user.email", "test@example.com"]);
  await mkdir(path.join(sourcePath, "src"));
  await writeFile(path.join(sourcePath, "src/app.ts"), "one\ntwo\nthree\n");
  await git(sourcePath, ["add", "."]);
  await git(sourcePath, ["commit", "-m", "base"]);
  const baseSha = (await git(sourcePath, ["rev-parse", "HEAD"])).trim();

  await git(sourcePath, ["switch", "-c", "feature"]);
  await writeFile(
    path.join(sourcePath, "src/app.ts"),
    "one\ntwo changed\nthree\n",
  );
  await git(sourcePath, ["add", "."]);
  await git(sourcePath, ["commit", "-m", "head"]);
  const headSha = (await git(sourcePath, ["rev-parse", "HEAD"])).trim();
  await git(sourcePath, ["update-ref", "refs/pull/7/head", headSha]);

  return { root, sourcePath, dataPath, baseSha, headSha };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return result.stdout;
}
