import { findingIdentity } from "./finding-identity.js";
import { createHash } from "node:crypto";

import type { ExactDiff } from "../repositories/diff.js";
import { filterFindingsToExactDiff } from "../validation/diff-anchors.js";
import {
  validateCompletedReviewOutput,
  type CompletedReviewOutput,
  type ReviewFinding,
} from "../validation/review-output.js";
import {
  GitHubApiError,
  type GitHubReviewClient,
  type GitHubReviewComment,
} from "./client.js";

const FULL_GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export interface PublishReviewInput {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly reviewedHeadSha: string;
  readonly exactDiff: ExactDiff;
  readonly output: CompletedReviewOutput;
  readonly reviewedBaseBranch?: string;
  readonly scopeSha?: string;
  readonly rejectedFindingCount?: number;
}

export interface PublisherOptions {
  readonly minimumConfidence?: number;
  readonly maximumInlineComments?: number;
  readonly publishEmptySummary?: boolean;
  readonly blockingPriority?: number;
  readonly findingContinuity?: boolean;
  readonly onBeforeWrite?: () => Promise<void>;
  readonly onBeforeRetire?: () => Promise<void>;
  readonly onBeforeReviewCreate?: (
    marker: string,
    blocking: boolean,
  ) => Promise<void>;
  readonly onReviewCreated?: (reviewId: number) => Promise<void>;
  readonly onOutcome?: (outcome: {
    blocking: boolean;
    incomplete: boolean;
    findings: number;
  }) => Promise<void>;
}

export type PublishReviewResult =
  | {
      readonly status: "published";
      readonly reviewId: number;
      readonly comments: number;
    }
  | { readonly status: "skipped"; readonly reason: "no-findings" }
  | {
      readonly status: "stale";
      readonly currentHeadSha: string;
      readonly currentBaseBranch?: string;
      readonly currentBaseSha?: string;
    }
  | {
      readonly status: "ineligible";
      readonly reason: "closed" | "draft" | "fork";
    };

export type PublishFailureResult =
  | { readonly status: "published"; readonly reviewId: number }
  | { readonly status: "stale"; readonly currentHeadSha: string }
  | {
      readonly status: "ineligible";
      readonly reason: "closed" | "draft" | "fork";
    };

export class GitHubReviewPublisher {
  readonly #client: GitHubReviewClient;
  readonly #minimumConfidence: number;
  readonly #maximumInlineComments: number;
  readonly #publishEmptySummary: boolean;
  readonly #blockingPriority: number;
  readonly #findingContinuity: boolean;
  readonly #onBeforeWrite: PublisherOptions["onBeforeWrite"];
  readonly #options: PublisherOptions;
  readonly #onOutcome: PublisherOptions["onOutcome"];

  constructor(client: GitHubReviewClient, options: PublisherOptions = {}) {
    this.#client = client;
    this.#options = options;
    this.#minimumConfidence = options.minimumConfidence ?? 0.8;
    this.#maximumInlineComments = options.maximumInlineComments ?? 20;
    this.#publishEmptySummary = options.publishEmptySummary ?? false;
    this.#findingContinuity = options.findingContinuity ?? false;
    this.#onOutcome = options.onOutcome;
    this.#onBeforeWrite = options.onBeforeWrite;
    this.#blockingPriority = options.blockingPriority ?? 1;
    if (
      !Number.isSafeInteger(this.#blockingPriority) ||
      this.#blockingPriority < 0 ||
      this.#blockingPriority > 3
    )
      throw new TypeError("blockingPriority must be between 0 and 3");
    if (this.#minimumConfidence < 0 || this.#minimumConfidence > 1) {
      throw new TypeError("minimumConfidence must be between 0 and 1");
    }
    if (
      !Number.isSafeInteger(this.#maximumInlineComments) ||
      this.#maximumInlineComments < 1
    ) {
      throw new TypeError("maximumInlineComments must be a positive integer");
    }
  }

  async retireSuperseded(input: PublishReviewInput): Promise<void> {
    validateInput(input);
    const marker = reviewPublicationMarker(
      input,
      this.#minimumConfidence,
      this.#blockingPriority,
    );
    const existing = await this.#client.findReview?.(
      input.repository,
      input.pullRequestNumber,
      input.reviewedHeadSha,
      marker,
    );
    if (existing?.state === "CHANGES_REQUESTED") {
      if (!this.#client.dismissReview)
        throw new TypeError("blocking review recovery requires dismissal");
      await this.#options.onBeforeRetire?.();
      await this.#client.dismissReview(
        input.repository,
        input.pullRequestNumber,
        existing.reviewId,
      );
    }
  }

  async publish(input: PublishReviewInput): Promise<PublishReviewResult> {
    validateInput(input);
    const validated = validateCompletedReviewOutput(input.output);
    let authoritativeDiff = input.exactDiff;
    if (this.#client.getReviewDiff !== undefined) {
      try {
        authoritativeDiff = await this.#client.getReviewDiff(
          input.repository,
          input.pullRequestNumber,
          input.exactDiff.baseSha,
          input.reviewedHeadSha,
        );
      } catch (error) {
        if (!(error instanceof GitHubApiError) || error.statusCode !== 409)
          throw error;
        const current = await this.#client.getPullRequest(
          input.repository,
          input.pullRequestNumber,
        );
        await this.retireSuperseded(input);
        return {
          status: "stale",
          currentHeadSha: current.headSha,
          ...(current.baseBranch === undefined
            ? {}
            : { currentBaseBranch: current.baseBranch }),
          ...(current.baseSha === undefined
            ? {}
            : { currentBaseSha: current.baseSha }),
        };
      }
    }
    const anchored = filterFindingsToExactDiff(validated, authoritativeDiff);
    const findings = anchored.review.findings.filter(
      (finding) => finding.confidence >= this.#minimumConfidence,
    );

    const pullRequest = await this.#client.getPullRequest(
      input.repository,
      input.pullRequestNumber,
    );
    if (pullRequest.state !== "open")
      return { status: "ineligible", reason: "closed" };
    if (pullRequest.draft) return { status: "ineligible", reason: "draft" };
    if (pullRequest.headRepository !== input.repository) {
      return { status: "ineligible", reason: "fork" };
    }
    if (
      pullRequest.headSha !== input.reviewedHeadSha.toLowerCase() ||
      (input.reviewedBaseBranch !== undefined &&
        pullRequest.baseBranch !== input.reviewedBaseBranch) ||
      (input.reviewedBaseBranch !== undefined &&
        pullRequest.baseSha !== input.exactDiff.baseSha)
    ) {
      await this.retireSuperseded(input);
      return {
        status: "stale",
        currentHeadSha: pullRequest.headSha,
        ...(pullRequest.baseBranch === undefined
          ? {}
          : { currentBaseBranch: pullRequest.baseBranch }),
        ...(pullRequest.baseSha === undefined
          ? {}
          : { currentBaseSha: pullRequest.baseSha }),
      };
    }
    if (findings.length === 0 && !this.#publishEmptySummary) {
      await this.#onBeforeWrite?.();
      await this.#onOutcome?.({
        blocking: false,
        incomplete:
          anchored.rejected.length + (input.rejectedFindingCount ?? 0) > 0,
        findings: 0,
      });
      return { status: "skipped", reason: "no-findings" };
    }
    const marker = reviewPublicationMarker(
      input,
      this.#minimumConfidence,
      this.#blockingPriority,
    );
    const existing = await this.#client.findReview?.(
      input.repository,
      input.pullRequestNumber,
      input.reviewedHeadSha,
      marker,
    );
    if (existing !== undefined && existing !== null) {
      await this.#onBeforeWrite?.();
      await this.#onOutcome?.({
        blocking: findings.some(
          (finding) => finding.priority <= this.#blockingPriority,
        ),
        incomplete:
          anchored.rejected.length + (input.rejectedFindingCount ?? 0) > 0,
        findings: findings.length,
      });
      return { status: "published", reviewId: existing.reviewId, comments: 0 };
    }

    const threads =
      this.#findingContinuity && findings.length > 0
        ? await this.#client.unresolvedFindingThreads?.(
            input.repository,
            input.pullRequestNumber,
          )
        : undefined;
    const continuing = findings.filter((finding) =>
      threads?.has(findingIdentity(finding)),
    );
    const newFindings = findings.filter(
      (finding) => !threads?.has(findingIdentity(finding)),
    );
    const inlineFindings = newFindings.slice(0, this.#maximumInlineComments);
    const overflowFindings = newFindings.slice(this.#maximumInlineComments);
    const noFindingOutcome =
      findings.length === 0
        ? anchored.rejected.length + (input.rejectedFindingCount ?? 0) > 0
          ? "Review completed with findings rejected by diff validation; no clean conclusion can be made."
          : anchored.review.findings.length === 0
            ? "No actionable issues were found in the reviewed changes."
            : "No findings met the configured confidence threshold."
        : undefined;
    await this.#onBeforeWrite?.();
    await this.#options.onBeforeReviewCreate?.(
      marker,
      findings.some((finding) => finding.priority <= this.#blockingPriority),
    );
    await this.#onBeforeWrite?.();
    const review = await this.#client.createReview({
      repository: input.repository,
      pullRequestNumber: input.pullRequestNumber,
      commitId: input.reviewedHeadSha.toLowerCase(),
      event: findings.some(
        (finding) => finding.priority <= this.#blockingPriority,
      )
        ? "REQUEST_CHANGES"
        : "COMMENT",
      body:
        buildReviewBody(
          anchored.review.summary,
          input.reviewedHeadSha,
          overflowFindings,
          noFindingOutcome,
        ) +
        (continuing.length === 0
          ? ""
          : `\n\nPreviously reported issues still present in this comparison:\n${continuing.map((finding) => `- P${finding.priority} \`${finding.path}:${finding.start_line}\` — [continuing discussion](${threads!.get(findingIdentity(finding))!})`).join("\n")}`) +
        `\n\n${marker}`,
      comments: inlineFindings.map(toReviewComment),
    });
    await this.#options.onReviewCreated?.(review.reviewId);
    if (this.#client.dismissReview !== undefined) {
      const current = await this.#client.getPullRequest(
        input.repository,
        input.pullRequestNumber,
      );
      if (
        current.state !== "open" ||
        current.draft ||
        current.headRepository !== input.repository ||
        current.headSha !== input.reviewedHeadSha ||
        (input.reviewedBaseBranch !== undefined &&
          (current.baseBranch !== input.reviewedBaseBranch ||
            current.baseSha !== input.exactDiff.baseSha))
      ) {
        if (
          findings.some((finding) => finding.priority <= this.#blockingPriority)
        )
          await this.#options.onBeforeRetire?.();
        if (
          findings.some((finding) => finding.priority <= this.#blockingPriority)
        )
          await this.#client.dismissReview(
            input.repository,
            input.pullRequestNumber,
            review.reviewId,
          );
        if (current.state !== "open")
          return { status: "ineligible", reason: "closed" };
        if (current.draft) return { status: "ineligible", reason: "draft" };
        if (current.headRepository !== input.repository)
          return { status: "ineligible", reason: "fork" };
        return {
          status: "stale",
          currentHeadSha: current.headSha,
          ...(current.baseBranch === undefined
            ? {}
            : { currentBaseBranch: current.baseBranch }),
          ...(current.baseSha === undefined
            ? {}
            : { currentBaseSha: current.baseSha }),
        };
      }
    }
    await this.#onOutcome?.({
      blocking: findings.some(
        (finding) => finding.priority <= this.#blockingPriority,
      ),
      incomplete:
        anchored.rejected.length + (input.rejectedFindingCount ?? 0) > 0,
      findings: findings.length,
    });
    return {
      status: "published",
      reviewId: review.reviewId,
      comments: inlineFindings.length,
    };
  }

  async publishFailure(input: {
    repository: string;
    pullRequestNumber: number;
    headSha: string;
    failureCode: string;
  }): Promise<PublishFailureResult> {
    validateFullSha(input.headSha, "headSha");
    const pullRequest = await this.#client.getPullRequest(
      input.repository,
      input.pullRequestNumber,
    );
    if (pullRequest.state !== "open")
      return { status: "ineligible", reason: "closed" };
    if (pullRequest.draft) return { status: "ineligible", reason: "draft" };
    if (pullRequest.headRepository !== input.repository) {
      return { status: "ineligible", reason: "fork" };
    }
    if (pullRequest.headSha !== input.headSha.toLowerCase()) {
      return { status: "stale", currentHeadSha: pullRequest.headSha };
    }
    const marker = `<!-- auto-agent-actions:failure:head=${input.headSha.toLowerCase()} -->`;
    const existing = await this.#client.findReview?.(
      input.repository,
      input.pullRequestNumber,
      input.headSha,
      marker,
    );
    if (existing !== undefined && existing !== null)
      return { status: "published", reviewId: existing.reviewId };
    await this.#onBeforeWrite?.();
    const review = await this.#client.createReview({
      repository: input.repository,
      pullRequestNumber: input.pullRequestNumber,
      commitId: input.headSha.toLowerCase(),
      event: "COMMENT",
      body: buildFailureBody(input.headSha, input.failureCode),
      comments: [],
    });
    return { status: "published", reviewId: review.reviewId };
  }
}

function buildFailureBody(headSha: string, failureCode: string): string {
  const reason =
    failureCode === "base-ref-changed"
      ? "the pull request base changed while the review was being prepared"
      : failureCode === "head-ref-changed"
        ? "the pull request head changed while the review was being prepared"
        : failureCode === "inspection-blocked"
          ? "required components could not be inspected reliably"
          : failureCode === "timeout"
            ? "the review exceeded its execution time limit"
            : "the analysis worker encountered an internal failure";
  return `**Automated review could not complete**\n\nNo review conclusion was produced for \`${headSha.slice(0, 7)}\` because ${reason}. The service will retry this head during reconciliation.\n\n<!-- auto-agent-actions:failure:head=${headSha.toLowerCase()} -->`;
}

function validateFullSha(value: string, name: string): void {
  if (!FULL_GIT_SHA_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a full Git object ID`);
  }
}

function toReviewComment(finding: ReviewFinding): GitHubReviewComment {
  const base = {
    path: finding.path,
    body: `**P${finding.priority}: ${finding.title}**\n\n${finding.body}\n\n<!-- auto-agent-actions:finding=${findingIdentity(finding)} -->`,
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
  const outcome =
    noFindingOutcome === undefined
      ? summary
      : `**Automated review completed**\n\n${noFindingOutcome}\n\n${summary}`;
  if (overflow.length === 0) return `${outcome}\n\n${marker}`;
  const overflowList = overflow
    .map(
      (finding) =>
        `- P${finding.priority} \`${finding.path}:${finding.start_line}\` — ${finding.title}`,
    )
    .join("\n");
  return `${outcome}\n\nAdditional findings omitted from inline comments:\n\n${overflowList}\n\n${marker}`;
}

function validateInput(input: PublishReviewInput): void {
  if (!FULL_GIT_SHA_PATTERN.test(input.reviewedHeadSha)) {
    throw new TypeError("reviewedHeadSha must be a full Git object ID");
  }
  if (
    input.exactDiff.headSha.toLowerCase() !==
    input.reviewedHeadSha.toLowerCase()
  ) {
    throw new TypeError("exactDiff head SHA must match reviewedHeadSha");
  }
}

export function reviewPublicationMarker(
  input: PublishReviewInput,
  minimumConfidence = 0.8,
  blockingPriority = 1,
): string {
  return `<!-- auto-agent-actions:review=${createHash("sha256")
    .update(
      JSON.stringify([
        input.reviewedHeadSha,
        input.exactDiff.baseSha,
        input.reviewedBaseBranch ?? "",
        input.scopeSha ?? "",
        minimumConfidence,
        blockingPriority,
      ]),
    )
    .digest("hex")} -->`;
}
