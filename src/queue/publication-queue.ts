import { createHash } from "node:crypto";
import path from "node:path";

import { Queue, type ConnectionOptions, type JobsOptions } from "bullmq";

import type { ExactDiff } from "../repositories/diff.js";
import {
  validateCompletedReviewOutput,
  type CompletedReviewOutput,
} from "../validation/review-output.js";
import {
  validateQueuedReviewRequest,
  type ReviewRequest,
} from "./review-queue.js";

export interface PublicationRequest {
  readonly reviewRequest: ReviewRequest;
  readonly exactDiff: ExactDiff;
  readonly output: CompletedReviewOutput;
  readonly rejectedFindingCount?: number;
}

export type AnalysisFailureCode =
  | "base-ref-changed"
  | "head-ref-changed"
  | "timeout"
  | "analysis-failed"
  | "inspection-blocked";

export interface FailurePublicationRequest {
  readonly reviewRequest: ReviewRequest;
  readonly failureCode: AnalysisFailureCode;
  readonly attemptId?: string;
}

export interface StatusPublicationRequest {
  readonly reviewRequest: ReviewRequest;
  readonly stage: "queued" | "running";
}
export interface CommentCommandRequest {
  readonly reviewRequest: ReviewRequest;
  readonly commentId: number;
}

export type PublicationJob =
  | PublicationRequest
  | FailurePublicationRequest
  | StatusPublicationRequest
  | CommentCommandRequest;

export interface PublicationQueue {
  enqueue(request: PublicationRequest): Promise<void>;
  enqueueCommand?(request: CommentCommandRequest): Promise<void>;
  enqueueStatus?(request: StatusPublicationRequest): Promise<void>;
  enqueueFailure(request: FailurePublicationRequest): Promise<void>;
}

interface QueueLike {
  getJob?(
    id: string,
  ): Promise<
    { getState(): Promise<string>; remove(): Promise<void> } | undefined
  >;
  add(
    name: "publish" | "notify-failure" | "status" | "command",
    data: PublicationJob,
    options: JobsOptions,
  ): Promise<unknown>;
  close(): Promise<void>;
}

export interface BullMqPublicationQueueOptions {
  readonly connection?: ConnectionOptions;
  readonly queueName?: string;
  readonly queue?: QueueLike;
}

export class BullMqPublicationQueue implements PublicationQueue {
  readonly #queue: QueueLike;

  constructor(options: BullMqPublicationQueueOptions) {
    if (options.queue !== undefined) {
      this.#queue = options.queue;
    } else {
      if (options.connection === undefined) {
        throw new TypeError(
          "connection is required when queue is not injected",
        );
      }
      this.#queue = new Queue<
        PublicationJob,
        unknown,
        "publish" | "notify-failure" | "status" | "command"
      >(options.queueName ?? "pull-request-publications", {
        connection: options.connection,
      });
    }
  }

  async enqueue(value: PublicationRequest): Promise<void> {
    const request = validatePublicationRequest(value);
    const jobId = createHash("sha256")
      .update(
        `${request.reviewRequest.repository}#${request.reviewRequest.pullRequestNumber}#${request.reviewRequest.headSha}#${request.reviewRequest.deliveryId}`,
      )
      .digest("hex");
    const previous = await this.#queue.getJob?.(jobId);
    if (previous !== undefined && (await previous.getState()) === "failed")
      await previous.remove();
    await this.#queue.add("publish", request, {
      jobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: { age: 30 * 24 * 60 * 60, count: 1_000 },
      removeOnFail: { age: 30 * 24 * 60 * 60, count: 1_000 },
      sizeLimit: 1024 * 1024,
      stackTraceLimit: 5,
    });
  }

  async enqueueCommand(value: CommentCommandRequest): Promise<void> {
    const request = validatePublicationJob(value);
    await this.#queue.add("command", request, {
      jobId: createHash("sha256")
        .update(`command#${value.reviewRequest.repository}#${value.commentId}`)
        .digest("hex"),
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: { age: 86400, count: 1000 },
      removeOnFail: { age: 86400, count: 1000 },
      sizeLimit: 16384,
    });
  }

  async enqueueStatus(value: StatusPublicationRequest): Promise<void> {
    const request = validatePublicationJob(value);
    await this.#queue.add("status", request, {
      jobId: createHash("sha256")
        .update(
          `status#${value.stage}#${value.reviewRequest.scopeSha ?? value.reviewRequest.headSha}#${value.reviewRequest.deliveryId}`,
        )
        .digest("hex"),
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: true,
      removeOnFail: { age: 86400, count: 1000 },
      sizeLimit: 16384,
    });
  }

  async enqueueFailure(value: FailurePublicationRequest): Promise<void> {
    const request = validateFailurePublicationRequest(value);
    const jobId = createHash("sha256")
      .update(
        `failure#${request.reviewRequest.repository}#${request.reviewRequest.pullRequestNumber}#${request.reviewRequest.headSha}#${request.reviewRequest.deliveryId}`,
      )
      .digest("hex");
    const previous = await this.#queue.getJob?.(jobId);
    if (previous !== undefined && (await previous.getState()) === "failed")
      await previous.remove();
    await this.#queue.add("notify-failure", request, {
      jobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: { age: 30 * 24 * 60 * 60, count: 1_000 },
      removeOnFail: { age: 30 * 24 * 60 * 60, count: 1_000 },
      sizeLimit: 32 * 1024,
      stackTraceLimit: 5,
    });
  }

  async close(): Promise<void> {
    await this.#queue.close();
  }
}

export function validatePublicationJob(value: unknown): PublicationJob {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === "commentId,reviewRequest"
  ) {
    const payload = value as Record<string, unknown>;
    if (
      typeof payload.commentId !== "number" ||
      !Number.isSafeInteger(payload.commentId) ||
      payload.commentId < 1
    )
      throw new TypeError("invalid comment command");
    return {
      reviewRequest: validateQueuedReviewRequest(payload.reviewRequest),
      commentId: payload.commentId,
    };
  }
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === "reviewRequest,stage"
  ) {
    const payload = value as Record<string, unknown>;
    if (payload.stage !== "queued" && payload.stage !== "running")
      throw new TypeError("invalid publication stage");
    return {
      reviewRequest: validateQueuedReviewRequest(payload.reviewRequest),
      stage: payload.stage,
    };
  }
  if (isFailurePublicationRequest(value))
    return validateFailurePublicationRequest(value);
  return validatePublicationRequest(value);
}

export function validateFailurePublicationRequest(
  value: unknown,
): FailurePublicationRequest {
  if (!isFailurePublicationRequest(value)) {
    throw new TypeError("failure publication queue payload is invalid");
  }
  const payload = value as Record<string, unknown>;
  const failureCode = payload.failureCode;
  if (
    typeof failureCode !== "string" ||
    !new Set([
      "base-ref-changed",
      "head-ref-changed",
      "timeout",
      "analysis-failed",
      "inspection-blocked",
    ]).has(failureCode)
  ) {
    throw new TypeError("failure publication code is invalid");
  }
  return Object.freeze({
    reviewRequest: validateQueuedReviewRequest(payload.reviewRequest),
    failureCode: failureCode as AnalysisFailureCode,
    ...(payload.attemptId === undefined
      ? {}
      : { attemptId: requireAttemptId(payload.attemptId) }),
  });
}

function isFailurePublicationRequest(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    [
      "failureCode,reviewRequest",
      "attemptId,failureCode,reviewRequest",
    ].includes(Object.keys(value).sort().join(","))
  );
}

export function validatePublicationRequest(value: unknown): PublicationRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("publication queue payload must be an object");
  }
  const payload = value as Record<string, unknown>;
  if (
    ![
      "exactDiff,output,reviewRequest",
      "exactDiff,output,rejectedFindingCount,reviewRequest",
    ].includes(Object.keys(payload).sort().join(","))
  ) {
    throw new TypeError("publication queue payload has unexpected properties");
  }
  const reviewRequest = validateQueuedReviewRequest(payload.reviewRequest);
  const exactDiff = validateExactDiff(payload.exactDiff, reviewRequest.headSha);
  const output = validateCompletedReviewOutput(payload.output);
  if (
    payload.rejectedFindingCount !== undefined &&
    (typeof payload.rejectedFindingCount !== "number" ||
      !Number.isSafeInteger(payload.rejectedFindingCount) ||
      payload.rejectedFindingCount < 0 ||
      payload.rejectedFindingCount > 1000)
  )
    throw new TypeError("rejected finding count is invalid");
  return Object.freeze({
    reviewRequest,
    exactDiff,
    output,
    ...(payload.rejectedFindingCount === undefined
      ? {}
      : { rejectedFindingCount: payload.rejectedFindingCount as number }),
  });
}

function validateExactDiff(value: unknown, expectedHeadSha: string): ExactDiff {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("publication exactDiff must be an object");
  }
  const diff = value as Record<string, unknown>;
  if (
    !["baseSha,files,headSha", "baseSha,files,headSha,mergeBaseSha"].includes(
      Object.keys(diff).sort().join(","),
    )
  ) {
    throw new TypeError("publication exactDiff has unexpected properties");
  }
  const baseSha = requireSha(diff.baseSha, "baseSha");
  const headSha = requireSha(diff.headSha, "headSha");
  if (headSha !== expectedHeadSha)
    throw new TypeError("publication head SHA does not match request");
  if (!Array.isArray(diff.files) || diff.files.length > 500) {
    throw new TypeError("publication exactDiff files are invalid");
  }
  const files = diff.files.map((value, index) =>
    validateChangedFile(value, index),
  );
  return {
    baseSha,
    headSha,
    files,
    ...(diff.mergeBaseSha === undefined
      ? {}
      : { mergeBaseSha: requireSha(diff.mergeBaseSha, "mergeBaseSha") }),
  };
}

function validateChangedFile(
  value: unknown,
  index: number,
): ExactDiff["files"][number] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`publication diff file ${index} is invalid`);
  }
  const file = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "status",
    "path",
    "previousPath",
    "isDeleted",
    "rightSideRanges",
  ]);
  if (Object.keys(file).some((key) => !allowedKeys.has(key))) {
    throw new TypeError(
      `publication diff file ${index} has unexpected properties`,
    );
  }
  if (typeof file.path !== "string" || !isSafeRepositoryPath(file.path)) {
    throw new TypeError(`publication diff file ${index} path is invalid`);
  }
  if (
    file.previousPath !== undefined &&
    (typeof file.previousPath !== "string" ||
      !isSafeRepositoryPath(file.previousPath))
  ) {
    throw new TypeError(
      `publication diff file ${index} previousPath is invalid`,
    );
  }
  if (
    typeof file.status !== "string" ||
    !new Set("AMDRCTUXB").has(file.status)
  ) {
    throw new TypeError(`publication diff file ${index} status is invalid`);
  }
  if (
    typeof file.isDeleted !== "boolean" ||
    !Array.isArray(file.rightSideRanges)
  ) {
    throw new TypeError(`publication diff file ${index} metadata is invalid`);
  }
  const rightSideRanges = file.rightSideRanges.map((range, rangeIndex) => {
    if (typeof range !== "object" || range === null || Array.isArray(range)) {
      throw new TypeError(
        `publication diff range ${index}/${rangeIndex} is invalid`,
      );
    }
    const candidate = range as Record<string, unknown>;
    if (
      Object.keys(candidate).sort().join(",") !== "end,start" ||
      typeof candidate.start !== "number" ||
      typeof candidate.end !== "number" ||
      !Number.isSafeInteger(candidate.start) ||
      !Number.isSafeInteger(candidate.end) ||
      candidate.start < 1 ||
      candidate.end < candidate.start
    ) {
      throw new TypeError(
        `publication diff range ${index}/${rangeIndex} is invalid`,
      );
    }
    return { start: candidate.start, end: candidate.end };
  });
  return {
    status: file.status as ExactDiff["files"][number]["status"],
    path: file.path,
    ...(typeof file.previousPath === "string"
      ? { previousPath: file.previousPath }
      : {}),
    isDeleted: file.isDeleted,
    rightSideRanges,
  };
}

function isSafeRepositoryPath(candidate: string): boolean {
  return (
    path.posix.normalize(candidate) === candidate &&
    !path.posix.isAbsolute(candidate) &&
    !candidate.split("/").includes("..")
  );
}

function requireSha(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)
  ) {
    throw new TypeError(`publication ${name} is invalid`);
  }
  return value.toLowerCase();
}

function requireAttemptId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(value))
    throw new TypeError("failure attempt is invalid");
  return value;
}
