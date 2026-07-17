import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { buildReviewPrompt } from "../codex/prompt.js";
import {
  runCodexReview,
  type CodexRunnerOptions,
  type ReasoningEffort,
} from "../codex/runner.js";
import { DiffInspector, type ExactDiff } from "../repositories/diff.js";
import {
  RepositoryManager,
  type GitHubFetchAuthentication,
} from "../repositories/manager.js";
import { filterFindingsToExactDiff, type RejectedFinding } from "../validation/diff-anchors.js";
import type { CompletedReviewOutput } from "../validation/review-output.js";

export interface ReviewCoreOptions {
  repository: string;
  remoteUrl: string;
  baseBranch: string;
  pullRequestNumber: number;
  expectedBaseSha: string;
  expectedHeadSha: string;
  dataDirectory: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  timeoutMs: number;
  schemaPath: string;
  instructionsPath: string;
  fetchAuthentication?: GitHubFetchAuthentication;
  codexBinary?: string;
  environment?: NodeJS.ProcessEnv;
}

export interface ReviewCoreResult {
  baseSha: string;
  headSha: string;
  exactDiff: ExactDiff;
  review: CompletedReviewOutput;
  rejectedFindings: RejectedFinding[];
}

export interface ReviewCoreDependencies {
  repositoryManager?: RepositoryManager;
  diffInspector?: DiffInspector;
  runCodex?: (options: CodexRunnerOptions) => Promise<CompletedReviewOutput>;
}

export async function runReviewCore(
  options: ReviewCoreOptions,
  dependencies: ReviewCoreDependencies = {},
): Promise<ReviewCoreResult> {
  validateOptions(options);
  const repositoryManager =
    dependencies.repositoryManager ??
    new RepositoryManager({ dataDirectory: options.dataDirectory });
  const diffInspector = dependencies.diffInspector ?? new DiffInspector();
  const executeCodex = dependencies.runCodex ?? runCodexReview;
  const fetched = await repositoryManager.fetchReviewRefs({
    repository: options.repository,
    remoteUrl: options.remoteUrl,
    baseBranch: options.baseBranch,
    pullRequestNumber: options.pullRequestNumber,
    expectedBaseSha: options.expectedBaseSha,
    expectedHeadSha: options.expectedHeadSha,
    ...(options.fetchAuthentication === undefined
      ? {}
      : { authentication: options.fetchAuthentication }),
  });

  return repositoryManager.withWorktree(
    {
      repository: options.repository,
      pullRequestNumber: options.pullRequestNumber,
      mirrorPath: fetched.mirrorPath,
      headSha: fetched.headSha,
    },
    async (worktree) => {
      const exactDiff = await diffInspector.inspect({
        worktreePath: worktree.path,
        baseSha: fetched.baseSha,
        headSha: fetched.headSha,
      });
      const outputPath = await createOutputPath(options);

      try {
        const output = await executeCodex({
          worktreePath: worktree.path,
          schemaPath: options.schemaPath,
          instructionsPath: options.instructionsPath,
          outputPath,
          model: options.model,
          reasoningEffort: options.reasoningEffort,
          prompt: buildReviewPrompt({
            repository: options.repository,
            pullRequestNumber: options.pullRequestNumber,
            baseSha: fetched.baseSha,
            headSha: fetched.headSha,
          }),
          timeoutMs: options.timeoutMs,
          ...(options.codexBinary === undefined
            ? {}
            : { codexBinary: options.codexBinary }),
          ...(options.environment === undefined
            ? {}
            : { environment: options.environment }),
        });
        const anchored = filterFindingsToExactDiff(output, exactDiff);
        return {
          baseSha: fetched.baseSha,
          headSha: fetched.headSha,
          exactDiff,
          review: anchored.review,
          rejectedFindings: anchored.rejected,
        };
      } finally {
        await rm(outputPath, { force: true });
      }
    },
  );
}

function validateOptions(options: ReviewCoreOptions): void {
  for (const [name, value] of [
    ["dataDirectory", options.dataDirectory],
    ["schemaPath", options.schemaPath],
    ["instructionsPath", options.instructionsPath],
  ] as const) {
    if (!path.isAbsolute(value)) throw new TypeError(`${name} must be an absolute path`);
  }
  if (!options.model || /\s/.test(options.model)) {
    throw new TypeError("model must be a non-empty identifier without whitespace");
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new TypeError("timeoutMs must be a positive integer");
  }
}

async function createOutputPath(options: ReviewCoreOptions): Promise<string> {
  const outputDirectory = path.join(
    options.dataDirectory,
    "outputs",
    options.repository,
    String(options.pullRequestNumber),
  );
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  return path.join(
    outputDirectory,
    `${options.expectedHeadSha.slice(0, 12)}-${randomUUID()}.json`,
  );
}
