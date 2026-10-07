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
import { runReviewCore } from "../../src/workflows/review-core.js";
import { DiskReviewCheckpointStore } from "../../src/codex/review-checkpoints.js";
import { ModelUsageLimitError } from "../../src/codex/model-limit.js";
import type { CodexRunnerOptions } from "../../src/codex/runner.js";
import { DEFAULT_MODEL_BUDGET, DEFAULT_REVIEW_RUN_BUDGET, ModelBudgetExceededError } from "../../src/codex/model-budget.js";

const execFileAsync = promisify(execFile);
let fixture: Awaited<ReturnType<typeof createRepositoryFixture>>;

beforeAll(async () => {
  fixture = await createRepositoryFixture();
});

afterAll(async () => {
  await rm(fixture.root, { recursive: true, force: true });
});

describe("local review workflow", () => {
  it("completes multiple independently budgeted units, integration and candidate verification in one run", async () => {
    const multi=await createRepositoryFixture(true);
    try {
      const local=workflowOptions(multi);
      const candidate={title:"Cross-component defect",body:"A concrete contract mismatch between changed modules.",priority:1 as const,confidence:0.95,path:"src/app.ts",start_line:2,end_line:2};
      const phases:string[]=[];
      const result=await runReviewCore({...local,repository:"example/project",remoteUrl:multi.sourcePath,baseBranch:"main",pullRequestNumber:7,expectedBaseSha:multi.baseSha,expectedHeadSha:multi.headSha,batchFiles:1,modelBudgetLimits:{...DEFAULT_MODEL_BUDGET,maxRequests:1},reviewRunBudgetLimits:{...DEFAULT_REVIEW_RUN_BUDGET,maxRequests:4}},{
        checkpointStore:{read:async()=>undefined,write:async()=>{}},
        runCodex:async invocation=>{
          const phase=invocation.modelContext!.phase;phases.push(phase);
          const release=await invocation.modelBudget!.invocation().acquire();
          invocation.modelBudget!.observe({inputTokens:4,cachedInputTokens:0,outputTokens:1});release();
          if(phase==="synthesis"){
            expect(invocation.prompt).toContain("Untrusted inspection notes");
            expect(invocation.expectedPaths).toEqual(["src/app.ts","src/other.ts"]);
          }
          return {status:"completed",blocked_reason:null,findings:phase==="inspection"?[]:[candidate],summary:phase==="synthesis"?"Cross-component contract checked.":"Assigned work completed."};
        },
      });
      expect(phases).toEqual(["inspection","inspection","synthesis","verification"]);
      expect(result.review.findings).toEqual([candidate]);
      expect(result.review.summary).toContain("Cross-component contract checked");
    }finally{await rm(multi.root,{recursive:true,force:true});}
  });
  it("does not return a completed review when the cross-component pass fails", async () => {
    const multi=await createRepositoryFixture(true);
    try{
      const local=workflowOptions(multi);const phases:string[]=[];
      await expect(runReviewCore({...local,repository:"example/project",remoteUrl:multi.sourcePath,baseBranch:"main",pullRequestNumber:7,expectedBaseSha:multi.baseSha,expectedHeadSha:multi.headSha,batchFiles:1},{
        checkpointStore:{read:async()=>undefined,write:async()=>{}},
        runCodex:async invocation=>{const phase=invocation.modelContext!.phase;phases.push(phase);if(phase==="synthesis")throw new Error("Integration incomplete");return {status:"completed",blocked_reason:null,findings:[],summary:"Assigned patch inspected."};},
      })).rejects.toThrow("Integration incomplete");
      expect(phases).toEqual(["inspection","inspection","synthesis"]);
    }finally{await rm(multi.root,{recursive:true,force:true});}
  });
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
            status: "completed",
            blocked_reason: null,
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
        status: "completed",
        blocked_reason: null,
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

  it("resumes cached inspection but always verifies candidates before returning a publishable result", async () => {
    const memory = new Map<string, string>();
    const checkpointStore = new DiskReviewCheckpointStore("/in-memory-checkpoints", {
      read: async (file) => memory.get(file),
      write: async (file, text) => { memory.set(file, text); },
    });
    const candidate = {
      title: "Changed line defect", body: "A concrete failure on the changed line.",
      priority: 1 as const, confidence: 0.95, path: "src/app.ts", start_line: 2, end_line: 2,
    };
    const output = { status: "completed" as const, blocked_reason: null, findings: [candidate], summary: "Candidate found." };
    const local = workflowOptions(fixture);
    const options = {
      ...local, repository: "example/project", remoteUrl: fixture.sourcePath, baseBranch: "main",
      pullRequestNumber: 7, expectedBaseSha: fixture.baseSha, expectedHeadSha: fixture.headSha,
      batchFiles: 1, verifyFindings: false,
    };
    const calls: CodexRunnerOptions[] = [];
    let limited = true;
    const runCodex = async (invocation: CodexRunnerOptions) => {
      calls.push(invocation);
      if (invocation.prompt.includes("Verify these candidate findings")) {
        expect(invocation.prompt).toContain("discard duplicate root causes");
        if (limited) throw new ModelUsageLimitError(Date.now() + 1000);
        return { ...output, findings: [], summary: "The candidate is already guarded and was discarded." };
      }
      return output;
    };
    await expect(runReviewCore(options, { checkpointStore, runCodex })).rejects.toBeInstanceOf(ModelUsageLimitError);
    expect(memory.size).toBe(1);
    limited = false;
    const result = await runReviewCore(options, { checkpointStore, runCodex });
    expect(calls).toHaveLength(3);
    expect(calls.filter((call) => call.prompt.includes("<inspection_group>"))).toHaveLength(1);
    expect(result.review.findings).toEqual([]);
    expect(result.review.summary).toContain("Candidate verification:");
    expect(result.review.summary).toContain("discarded");
  });

  it("rejects a grouped verification that invents or changes a finding", async () => {
    const local = workflowOptions(fixture);
    const candidate = {
      title: "Changed line defect", body: "A concrete failure on the changed line.",
      priority: 1 as const, confidence: 0.95, path: "src/app.ts", start_line: 2, end_line: 2,
    };
    const output = { status: "completed" as const, blocked_reason: null, findings: [candidate], summary: "Candidate found." };
    await expect(runReviewCore({
      ...local, repository: "example/project", remoteUrl: fixture.sourcePath, baseBranch: "main",
      pullRequestNumber: 7, expectedBaseSha: fixture.baseSha, expectedHeadSha: fixture.headSha,
      batchFiles: 1, verifyFindings: false,
    }, {
      checkpointStore: { read: async () => undefined, write: async () => {} },
      runCodex: async (invocation) => invocation.prompt.includes("Verify these candidate findings")
        ? { ...output, findings: [{ ...candidate, body: "Invented claim" }] } : output,
    })).rejects.toThrow("verification introduced or changed a candidate");
  });

  it("charges independent inspection and verification units to the same PR ceiling and resumes validated checkpoints", async () => {
    const local = workflowOptions(fixture);
    const memory = new Map<string, string>();
    const checkpointStore = new DiskReviewCheckpointStore("/in-memory-checkpoints", {
      read: async (file) => memory.get(file),
      write: async (file, text) => { memory.set(file, text); },
    });
    const candidate = { title: "Changed line defect", body: "Concrete failure.", priority: 1 as const,
      confidence: 0.95, path: "src/app.ts", start_line: 2, end_line: 2 };
    const options = {
      ...local, repository: "example/project", remoteUrl: fixture.sourcePath, baseBranch: "main",
      pullRequestNumber: 7, expectedBaseSha: fixture.baseSha, expectedHeadSha: fixture.headSha,
      batchFiles: 1, modelBudgetLimits: { ...DEFAULT_MODEL_BUDGET, maxRequests: 1 },
      reviewRunBudgetLimits: { ...DEFAULT_REVIEW_RUN_BUDGET, maxRequests: 1 },
    };
    let requests = 0;
    const phases: string[] = [];
    const runCodex = async (invocation: CodexRunnerOptions) => {
      phases.push(invocation.modelContext!.phase);
      const release = await invocation.modelBudget!.invocation().acquire();
      requests++;
      invocation.modelBudget!.observe({ inputTokens: 4, cachedInputTokens: 2, outputTokens: 1 });
      release();
      return { status: "completed" as const, blocked_reason: null, findings: [candidate], summary: "Verified defect." };
    };
    await expect(runReviewCore(options, { checkpointStore, runCodex })).rejects.toBeInstanceOf(ModelBudgetExceededError);
    expect(requests).toBe(1); expect(memory.size).toBe(1);
    const result = await runReviewCore({ ...options, reviewRunBudgetLimits: { ...DEFAULT_REVIEW_RUN_BUDGET, maxRequests: 2 } }, { checkpointStore, runCodex });
    expect(requests).toBe(2);
    expect(phases).toEqual(["inspection", "verification", "verification"]);
    expect(result.review.findings).toEqual([candidate]);
  });

  it("rejects budgeted direct execution before model access when isolation is disabled", async () => {
    const local = workflowOptions(fixture);
    await expect(runReviewCore({
      ...local, repository: "example/project", remoteUrl: fixture.sourcePath, baseBranch: "main",
      pullRequestNumber: 7, expectedBaseSha: fixture.baseSha, expectedHeadSha: fixture.headSha,
      modelBudgetLimits: DEFAULT_MODEL_BUDGET,
    })).rejects.toThrow("model budget enforcement requires per-job isolation");
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

async function createRepositoryFixture(multi = false): Promise<{
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
  if (multi) await writeFile(path.join(sourcePath, "src/other.ts"), "old\n");
  await git(sourcePath, ["add", "."]);
  await git(sourcePath, ["commit", "-m", "base"]);
  const baseSha = (await git(sourcePath, ["rev-parse", "HEAD"])).trim();

  await git(sourcePath, ["switch", "-c", "feature"]);
  await writeFile(
    path.join(sourcePath, "src/app.ts"),
    "one\ntwo changed\nthree\n",
  );
  if (multi) await writeFile(path.join(sourcePath, "src/other.ts"), "new\n");
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
