import { createHash } from "node:crypto";
import path from "node:path";

import { Queue, type ConnectionOptions, type JobsOptions } from "bullmq";

import type { ExactDiff } from "../repositories/diff.js";
import {
  validateCompletedReviewOutput,
  type CompletedReviewOutput,
} from "../validation/review-output.js";
import { validateQueuedReviewRequest, type ReviewRequest } from "./review-queue.js";

export interface PublicationRequest {
  readonly reviewRequest: ReviewRequest;
  readonly exactDiff: ExactDiff;
  readonly output: CompletedReviewOutput;
}

export interface PublicationQueue {
  enqueue(request: PublicationRequest): Promise<void>;
}

interface QueueLike {
  add(name: "publish", data: PublicationRequest, options: JobsOptions): Promise<unknown>;
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
        throw new TypeError("connection is required when queue is not injected");
      }
      this.#queue = new Queue<PublicationRequest, unknown, "publish">(
        options.queueName ?? "pull-request-publications",
        { connection: options.connection },
      );
    }
  }

  async enqueue(value: PublicationRequest): Promise<void> {
    const request = validatePublicationRequest(value);
    const jobId = createHash("sha256")
      .update(
        `${request.reviewRequest.repository}#${request.reviewRequest.pullRequestNumber}#${request.reviewRequest.headSha}`,
      )
      .digest("hex");
    await this.#queue.add("publish", request, {
      jobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: { age: 30 * 24 * 60 * 60, count: 10_000 },
      removeOnFail: { age: 30 * 24 * 60 * 60, count: 10_000 },
      sizeLimit: 1024 * 1024,
      stackTraceLimit: 5,
    });
  }

  async close(): Promise<void> {
    await this.#queue.close();
  }
}

export function validatePublicationRequest(value: unknown): PublicationRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("publication queue payload must be an object");
  }
  const payload = value as Record<string, unknown>;
  if (Object.keys(payload).sort().join(",") !== "exactDiff,output,reviewRequest") {
    throw new TypeError("publication queue payload has unexpected properties");
  }
  const reviewRequest = validateQueuedReviewRequest(payload.reviewRequest);
  const exactDiff = validateExactDiff(payload.exactDiff, reviewRequest.headSha);
  const output = validateCompletedReviewOutput(payload.output);
  return Object.freeze({ reviewRequest, exactDiff, output });
}

function validateExactDiff(value: unknown, expectedHeadSha: string): ExactDiff {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("publication exactDiff must be an object");
  }
  const diff = value as Record<string, unknown>;
  if (Object.keys(diff).sort().join(",") !== "baseSha,files,headSha") {
    throw new TypeError("publication exactDiff has unexpected properties");
  }
  const baseSha = requireSha(diff.baseSha, "baseSha");
  const headSha = requireSha(diff.headSha, "headSha");
  if (headSha !== expectedHeadSha) throw new TypeError("publication head SHA does not match request");
  if (!Array.isArray(diff.files) || diff.files.length > 500) {
    throw new TypeError("publication exactDiff files are invalid");
  }
  const files = diff.files.map((value, index) => validateChangedFile(value, index));
  return { baseSha, headSha, files };
}

function validateChangedFile(value: unknown, index: number): ExactDiff["files"][number] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`publication diff file ${index} is invalid`);
  }
  const file = value as Record<string, unknown>;
  const allowedKeys = new Set(["status", "path", "previousPath", "isDeleted", "rightSideRanges"]);
  if (Object.keys(file).some((key) => !allowedKeys.has(key))) {
    throw new TypeError(`publication diff file ${index} has unexpected properties`);
  }
  if (typeof file.path !== "string" || !isSafeRepositoryPath(file.path)) {
    throw new TypeError(`publication diff file ${index} path is invalid`);
  }
  if (
    file.previousPath !== undefined &&
    (typeof file.previousPath !== "string" || !isSafeRepositoryPath(file.previousPath))
  ) {
    throw new TypeError(`publication diff file ${index} previousPath is invalid`);
  }
  if (typeof file.status !== "string" || !new Set("AMDRCTUXB").has(file.status)) {
    throw new TypeError(`publication diff file ${index} status is invalid`);
  }
  if (typeof file.isDeleted !== "boolean" || !Array.isArray(file.rightSideRanges)) {
    throw new TypeError(`publication diff file ${index} metadata is invalid`);
  }
  const rightSideRanges = file.rightSideRanges.map((range, rangeIndex) => {
    if (typeof range !== "object" || range === null || Array.isArray(range)) {
      throw new TypeError(`publication diff range ${index}/${rangeIndex} is invalid`);
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
      throw new TypeError(`publication diff range ${index}/${rangeIndex} is invalid`);
    }
    return { start: candidate.start, end: candidate.end };
  });
  return {
    status: file.status as ExactDiff["files"][number]["status"],
    path: file.path,
    ...(typeof file.previousPath === "string" ? { previousPath: file.previousPath } : {}),
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
  if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)) {
    throw new TypeError(`publication ${name} is invalid`);
  }
  return value.toLowerCase();
}
