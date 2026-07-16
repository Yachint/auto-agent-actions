import type { ReasoningEffort } from "../codex/runner.js";
import {
  parsePullRequestFixture,
} from "../github/pull-request-fixture.js";
import type { ReviewOutput } from "../validation/review-output.js";
import {
  runReviewCore,
  type ReviewCoreDependencies,
} from "./review-core.js";

export interface LocalReviewOptions {
  fixture: unknown;
  dataDirectory: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  timeoutMs: number;
  schemaPath: string;
  instructionsPath: string;
  remoteUrlOverride?: string;
  codexBinary?: string;
  environment?: NodeJS.ProcessEnv;
}

export interface LocalReviewResult {
  repository: string;
  pull_request_number: number;
  base_sha: string;
  head_sha: string;
  review: ReviewOutput;
  rejected_findings: Array<{
    title: string;
    path: string;
    start_line: number;
    end_line: number;
    reason: "path-or-line-range-not-in-reviewed-diff";
  }>;
}

export type LocalReviewDependencies = ReviewCoreDependencies;

export async function runLocalReview(
  options: LocalReviewOptions,
  dependencies: LocalReviewDependencies = {},
): Promise<LocalReviewResult> {
  const event = parsePullRequestFixture(options.fixture);
  const result = await runReviewCore({
    repository: event.repository,
    remoteUrl: options.remoteUrlOverride ?? event.remoteUrl,
    baseBranch: event.baseBranch,
    pullRequestNumber: event.pullRequestNumber,
    expectedBaseSha: event.baseSha,
    expectedHeadSha: event.headSha,
    dataDirectory: options.dataDirectory,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    timeoutMs: options.timeoutMs,
    schemaPath: options.schemaPath,
    instructionsPath: options.instructionsPath,
    ...(options.codexBinary === undefined ? {} : { codexBinary: options.codexBinary }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  }, dependencies);

  return {
    repository: event.repository,
    pull_request_number: event.pullRequestNumber,
    base_sha: result.baseSha,
    head_sha: result.headSha,
    review: result.review,
    rejected_findings: result.rejectedFindings.map(({ finding, reason }) => ({
      title: finding.title,
      path: finding.path,
      start_line: finding.start_line,
      end_line: finding.end_line,
      reason,
    })),
  };
}
