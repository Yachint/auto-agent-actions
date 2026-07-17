import type { ExactDiff } from "../repositories/diff.js";
import { filterFindingsToExactDiff } from "../validation/diff-anchors.js";
import {
  validateReviewOutput,
  type ReviewFinding,
  type ReviewOutput,
} from "../validation/review-output.js";
import type { GitHubReviewClient, GitHubReviewComment } from "./client.js";

const FULL_GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export interface PublishReviewInput {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly reviewedHeadSha: string;
  readonly exactDiff: ExactDiff;
  readonly output: ReviewOutput;
}

export interface PublisherOptions {
  readonly minimumConfidence?: number;
  readonly maximumInlineComments?: number;
  readonly publishEmptySummary?: boolean;
}

export type PublishReviewResult =
  | { readonly status: "published"; readonly reviewId: number; readonly comments: number }
  | { readonly status: "skipped"; readonly reason: "no-findings" }
  | { readonly status: "stale"; readonly currentHeadSha: string }
  | { readonly status: "ineligible"; readonly reason: "closed" | "draft" | "fork" };

export class GitHubReviewPublisher {
  readonly #client: GitHubReviewClient;
  readonly #minimumConfidence: number;
  readonly #maximumInlineComments: number;
  readonly #publishEmptySummary: boolean;

  constructor(client: GitHubReviewClient, options: PublisherOptions = {}) {
    this.#client = client;
    this.#minimumConfidence = options.minimumConfidence ?? 0.8;
    this.#maximumInlineComments = options.maximumInlineComments ?? 20;
    this.#publishEmptySummary = options.publishEmptySummary ?? false;
    if (this.#minimumConfidence < 0 || this.#minimumConfidence > 1) {
      throw new TypeError("minimumConfidence must be between 0 and 1");
    }
    if (!Number.isSafeInteger(this.#maximumInlineComments) || this.#maximumInlineComments < 1) {
      throw new TypeError("maximumInlineComments must be a positive integer");
    }
  }

  async publish(input: PublishReviewInput): Promise<PublishReviewResult> {
    validateInput(input);
    const validated = validateReviewOutput(input.output);
    const anchored = filterFindingsToExactDiff(validated, input.exactDiff);
    const findings = anchored.review.findings.filter(
      (finding) => finding.confidence >= this.#minimumConfidence,
    );

    if (findings.length === 0 && !this.#publishEmptySummary) {
      return { status: "skipped", reason: "no-findings" };
    }

    const pullRequest = await this.#client.getPullRequest(
      input.repository,
      input.pullRequestNumber,
    );
    if (pullRequest.state !== "open") return { status: "ineligible", reason: "closed" };
    if (pullRequest.draft) return { status: "ineligible", reason: "draft" };
    if (pullRequest.headRepository !== input.repository) {
      return { status: "ineligible", reason: "fork" };
    }
    if (pullRequest.headSha !== input.reviewedHeadSha.toLowerCase()) {
      return { status: "stale", currentHeadSha: pullRequest.headSha };
    }

    const inlineFindings = findings.slice(0, this.#maximumInlineComments);
    const overflowFindings = findings.slice(this.#maximumInlineComments);
    const noFindingOutcome = findings.length === 0
      ? anchored.review.findings.length === 0
        ? "No actionable issues were found in the reviewed changes."
        : "No findings met the configured confidence threshold."
      : undefined;
    const review = await this.#client.createReview({
      repository: input.repository,
      pullRequestNumber: input.pullRequestNumber,
      commitId: input.reviewedHeadSha.toLowerCase(),
      event: "COMMENT",
      body: buildReviewBody(
        anchored.review.summary,
        input.reviewedHeadSha,
        overflowFindings,
        noFindingOutcome,
      ),
      comments: inlineFindings.map(toReviewComment),
    });
    return { status: "published", reviewId: review.reviewId, comments: inlineFindings.length };
  }
}

function toReviewComment(finding: ReviewFinding): GitHubReviewComment {
  const base = {
    path: finding.path,
    body: `**P${finding.priority}: ${finding.title}**\n\n${finding.body}`,
    line: finding.end_line,
    side: "RIGHT" as const,
  };
  return finding.start_line === finding.end_line
    ? base
    : { ...base, start_line: finding.start_line, start_side: "RIGHT" as const };
}

function buildReviewBody(
  summary: string,
  headSha: string,
  overflow: readonly ReviewFinding[],
  noFindingOutcome?: string,
): string {
  const marker = `<!-- auto-agent-actions:head=${headSha.toLowerCase()} -->`;
  const outcome = noFindingOutcome === undefined
    ? summary
    : `**Automated review completed**\n\n${noFindingOutcome}\n\n${summary}`;
  if (overflow.length === 0) return `${outcome}\n\n${marker}`;
  const overflowList = overflow
    .map((finding) => `- P${finding.priority} \`${finding.path}:${finding.start_line}\` — ${finding.title}`)
    .join("\n");
  return `${outcome}\n\nAdditional findings omitted from inline comments:\n\n${overflowList}\n\n${marker}`;
}

function validateInput(input: PublishReviewInput): void {
  if (!FULL_GIT_SHA_PATTERN.test(input.reviewedHeadSha)) {
    throw new TypeError("reviewedHeadSha must be a full Git object ID");
  }
  if (input.exactDiff.headSha.toLowerCase() !== input.reviewedHeadSha.toLowerCase()) {
    throw new TypeError("exactDiff head SHA must match reviewedHeadSha");
  }
}
