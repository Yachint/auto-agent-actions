import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  rename,
  rm,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DiffInspector, DiffLimitError } from "../../src/repositories/diff.js";
import {
  createGitEnvironment,
  type GitCommand,
} from "../../src/repositories/git.js";
import {
  RepositoryManager,
  StaleReviewRefError,
} from "../../src/repositories/manager.js";
import { filterFindingsToExactDiff } from "../../src/validation/diff-anchors.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
let fixture: Awaited<ReturnType<typeof createRepositoryFixture>>;

beforeAll(async () => {
  fixture = await createRepositoryFixture();
});

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("repository manager and exact diff inspection", () => {
  it("fetches exact refs, creates a detached worktree, and removes it", async () => {
    const manager = new RepositoryManager({ dataDirectory: fixture.dataPath });
    const fetched = await manager.fetchReviewRefs({
      repository: "example/project",
      remoteUrl: fixture.sourcePath,
      baseBranch: "main",
      pullRequestNumber: 7,
      expectedBaseSha: fixture.baseSha,
      expectedHeadSha: fixture.headSha,
    });

    expect(fetched.baseSha).toBe(fixture.baseSha);
    expect(fetched.headSha).toBe(fixture.headSha);

    let createdWorktreePath = "";
    await manager.withWorktree(
      {
        repository: "example/project",
        pullRequestNumber: 7,
        mirrorPath: fetched.mirrorPath,
        headSha: fetched.headSha,
      },
      async (worktree) => {
        createdWorktreePath = worktree.path;
        const head = await git(worktree.path, ["rev-parse", "HEAD"]);
        expect(head.trim()).toBe(fixture.headSha);
        expect(await git(worktree.path, ["status", "--porcelain"])).toBe("");
      },
    );

    await expect(access(createdWorktreePath)).rejects.toThrow();
  });

  it("removes only allowlisted abandoned worktrees older than the safety threshold", async () => {
    const { worktreePath } = await checkedOutFixture(fixture);
    const oldDate = new Date("2026-07-14T00:00:00.000Z");
    await utimes(worktreePath, oldDate, oldDate);
    const manager = new RepositoryManager({ dataDirectory: fixture.dataPath });

    await expect(
      manager.cleanupAbandonedWorktrees(
        new Set(["example/project"]),
        24 * 60 * 60 * 1_000,
        new Date("2026-07-16T00:00:00.000Z"),
      ),
    ).resolves.toBe(1);
    await expect(access(worktreePath)).rejects.toThrow();
  });

  it("extracts only right-side changed line ranges and filters findings", async () => {
    const { worktreePath, dispose } = await checkedOutFixture(fixture);

    try {
      const diff = await new DiffInspector().inspect({
        worktreePath,
        baseSha: fixture.baseSha,
        headSha: fixture.headSha,
      });

      expect(diff.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: "M",
            path: "src/app.ts",
            rightSideRanges: [
              { start: 2, end: 2 },
              { start: 5, end: 5 },
            ],
          }),
          expect.objectContaining({
            status: "A",
            path: "new-file.ts",
            rightSideRanges: [{ start: 1, end: 2 }],
          }),
          expect.objectContaining({
            status: "D",
            path: "deleted.txt",
            isDeleted: true,
            rightSideRanges: [],
          }),
          expect.objectContaining({
            status: "R",
            path: "new-name.txt",
            previousPath: "old-name.txt",
            rightSideRanges: [{ start: 5, end: 5 }],
          }),
        ]),
      );

      const validFinding = {
        title: "Changed line",
        body: "This line is part of the reviewed diff.",
        priority: 1 as const,
        confidence: 0.9,
        path: "src/app.ts",
        start_line: 2,
        end_line: 2,
      };
      const filtered = filterFindingsToExactDiff(
        {
          status: "completed",
          blocked_reason: null,
          findings: [
            validFinding,
            { ...validFinding, start_line: 3, end_line: 3 },
            { ...validFinding, path: "deleted.txt", start_line: 1, end_line: 1 },
          ],
          summary: "Review summary",
        },
        diff,
      );

      expect(filtered.review.findings).toEqual([validFinding]);
      expect(filtered.rejected).toHaveLength(2);
    } finally {
      await dispose();
    }
  });

  it("rejects stale fetched refs", async () => {
    const manager = new RepositoryManager({ dataDirectory: fixture.dataPath });

    await expect(
      manager.fetchReviewRefs({
        repository: "example/project",
        remoteUrl: fixture.sourcePath,
        baseBranch: "main",
        pullRequestNumber: 7,
        expectedBaseSha: fixture.baseSha,
        expectedHeadSha: fixture.baseSha,
      }),
    ).rejects.toThrow(StaleReviewRefError);
  });

  it("rejects embedded remote credentials before running Git", async () => {
    const manager = new RepositoryManager({ dataDirectory: fixture.dataPath });

    await expect(
      manager.fetchReviewRefs({
        repository: "example/project",
        remoteUrl: "https://token@example.com/project.git",
        baseBranch: "main",
        pullRequestNumber: 7,
        expectedBaseSha: fixture.baseSha,
        expectedHeadSha: fixture.headSha,
      }),
    ).rejects.toThrow(/embedded credentials/);
  });

  it("passes private GitHub credentials only through a temporary askpass environment", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "auto-agent-private-fetch-"));
    temporaryDirectories.push(root);
    const dataPath = path.join(root, "data");
    await mkdir(dataPath);
    let authenticatedCommand: GitCommand | undefined;
    const executor = async (command: GitCommand) => {
      if (command.args[0] === "init") {
        await mkdir(command.args[2]!, { recursive: true });
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      if (command.args.includes("fetch")) {
        authenticatedCommand = command;
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      const revision = command.args.at(-1) ?? "";
      return {
        stdout: Buffer.from(revision.includes("/base") ? fixture.baseSha : fixture.headSha),
        stderr: Buffer.alloc(0),
      };
    };
    const manager = new RepositoryManager({ dataDirectory: dataPath, gitExecutor: executor });

    await manager.fetchReviewRefs({
      repository: "example/project",
      remoteUrl: "https://github.com/example/project.git",
      baseBranch: "main",
      pullRequestNumber: 7,
      expectedBaseSha: fixture.baseSha,
      expectedHeadSha: fixture.headSha,
      authentication: { installationToken: "ghs_variable_length_secret" },
    });

    expect(authenticatedCommand).toBeDefined();
    expect(authenticatedCommand!.args.join(" ")).not.toContain("ghs_variable_length_secret");
    expect(authenticatedCommand!.args).toContain("https://github.com/example/project.git");
    expect(authenticatedCommand!.authentication).toEqual({
      askPassPath: expect.stringContaining(`${path.sep}runtime-auth${path.sep}git-`),
      username: "x-access-token",
      password: "ghs_variable_length_secret",
    });
    await expect(access(authenticatedCommand!.authentication!.askPassPath)).rejects.toThrow();
  });

  it("rejects authenticated fetches whose URL does not exactly match the repository", async () => {
    const manager = new RepositoryManager({ dataDirectory: fixture.dataPath });
    await expect(
      manager.fetchReviewRefs({
        repository: "example/project",
        remoteUrl: "https://example.com/example/project.git",
        baseBranch: "main",
        pullRequestNumber: 7,
        expectedBaseSha: fixture.baseSha,
        expectedHeadSha: fixture.headSha,
        authentication: { installationToken: "secret" },
      }),
    ).rejects.toThrow(/exactly match the GitHub repository/);
  });

  it("removes the temporary askpass helper when Git fetch fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "auto-agent-failed-private-fetch-"));
    temporaryDirectories.push(root);
    const dataPath = path.join(root, "data");
    await mkdir(dataPath);
    let askPassPath = "";
    const executor = async (command: GitCommand) => {
      if (command.args[0] === "init") {
        await mkdir(command.args[2]!, { recursive: true });
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      if (command.args.includes("fetch")) {
        askPassPath = command.authentication!.askPassPath;
        throw new Error("simulated fetch failure");
      }
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };
    const manager = new RepositoryManager({ dataDirectory: dataPath, gitExecutor: executor });

    await expect(
      manager.fetchReviewRefs({
        repository: "example/project",
        remoteUrl: "https://github.com/example/project.git",
        baseBranch: "main",
        pullRequestNumber: 7,
        expectedBaseSha: fixture.baseSha,
        expectedHeadSha: fixture.headSha,
        authentication: { installationToken: "secret" },
      }),
    ).rejects.toThrow(/simulated fetch failure/);
    expect(askPassPath).not.toBe("");
    await expect(access(askPassPath)).rejects.toThrow();
  });

  it("enforces the changed-file limit", async () => {
    const { worktreePath, dispose } = await checkedOutFixture(fixture);

    try {
      await expect(
        new DiffInspector({ maxChangedFiles: 1 }).inspect({
          worktreePath,
          baseSha: fixture.baseSha,
          headSha: fixture.headSha,
        }),
      ).rejects.toThrow(DiffLimitError);
    } finally {
      await dispose();
    }
  });
});

describe("Git environment", () => {
  it("drops unrelated credentials and disables ambient config and prompts", () => {
    expect(
      createGitEnvironment({
        PATH: "/usr/bin",
        HOME: "/tmp/home",
        GITHUB_TOKEN: "secret",
        NODE_OPTIONS: "--require=secret",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
      }),
    ).toEqual({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    });
  });
});

async function checkedOutFixture(repositoryFixture: typeof fixture): Promise<{
  worktreePath: string;
  dispose: () => Promise<void>;
}> {
  const manager = new RepositoryManager({
    dataDirectory: repositoryFixture.dataPath,
  });
  const fetched = await manager.fetchReviewRefs({
    repository: "example/project",
    remoteUrl: repositoryFixture.sourcePath,
    baseBranch: "main",
    pullRequestNumber: 7,
    expectedBaseSha: repositoryFixture.baseSha,
    expectedHeadSha: repositoryFixture.headSha,
  });
  const worktree = await manager.createWorktree({
    repository: "example/project",
    pullRequestNumber: 7,
    mirrorPath: fetched.mirrorPath,
    headSha: fetched.headSha,
  });
  return { worktreePath: worktree.path, dispose: worktree.dispose };
}

async function createRepositoryFixture(): Promise<{
  sourcePath: string;
  dataPath: string;
  baseSha: string;
  headSha: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "auto-agent-git-"));
  temporaryDirectories.push(root);
  const sourcePath = path.join(root, "source");
  const dataPath = path.join(root, "data");
  await mkdir(sourcePath);
  await mkdir(dataPath);
  await git(sourcePath, ["init", "--initial-branch=main"]);
  await git(sourcePath, ["config", "user.name", "Test User"]);
  await git(sourcePath, ["config", "user.email", "test@example.com"]);

  await mkdir(path.join(sourcePath, "src"));
  await writeFile(path.join(sourcePath, "src/app.ts"), "one\ntwo\nthree\nfour\n");
  await writeFile(path.join(sourcePath, "deleted.txt"), "delete me\n");
  await writeFile(
    path.join(sourcePath, "old-name.txt"),
    "same\ncontent\nline three\nline four\n",
  );
  await git(sourcePath, ["add", "."]);
  await git(sourcePath, ["commit", "-m", "base"]);
  const baseSha = (await git(sourcePath, ["rev-parse", "HEAD"])).trim();

  await git(sourcePath, ["switch", "-c", "feature"]);
  await writeFile(
    path.join(sourcePath, "src/app.ts"),
    "one\ntwo changed\nthree\nfour\nfive added\n",
  );
  await writeFile(path.join(sourcePath, "new-file.ts"), "alpha\nbeta\n");
  await unlink(path.join(sourcePath, "deleted.txt"));
  await rename(
    path.join(sourcePath, "old-name.txt"),
    path.join(sourcePath, "new-name.txt"),
  );
  await writeFile(
    path.join(sourcePath, "new-name.txt"),
    "same\ncontent\nline three\nline four\nadded after rename\n",
  );
  await git(sourcePath, ["add", "--all"]);
  await git(sourcePath, ["commit", "-m", "head"]);
  const headSha = (await git(sourcePath, ["rev-parse", "HEAD"])).trim();
  await git(sourcePath, ["update-ref", "refs/pull/7/head", headSha]);

  return { sourcePath, dataPath, baseSha, headSha };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return result.stdout;
}
