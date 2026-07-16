import { createHash } from "node:crypto";

import { Queue, type ConnectionOptions, type JobsOptions } from "bullmq";

import type { ReviewQueue, ReviewRequest } from "./review-queue.js";
import { reviewConcurrencyKey, type ReviewStateStore } from "./review-state.js";

interface QueueLike {
  add(name: "review", data: ReviewRequest, options: JobsOptions): Promise<unknown>;
  close(): Promise<void>;
}

export interface BullMqReviewQueueOptions {
  readonly connection?: ConnectionOptions;
  readonly queueName?: string;
  readonly debounceMs?: number;
  readonly queue?: QueueLike;
  readonly stateStore: ReviewStateStore;
}

export class BullMqReviewQueue implements ReviewQueue {
  readonly #queue: QueueLike;
  readonly #stateStore: ReviewStateStore;
  readonly #debounceMs: number;

  constructor(options: BullMqReviewQueueOptions) {
    this.#stateStore = options.stateStore;
    this.#debounceMs = options.debounceMs ?? 1_000;
    if (!Number.isSafeInteger(this.#debounceMs) || this.#debounceMs < 1) {
      throw new TypeError("debounceMs must be a positive integer");
    }
    if (options.queue !== undefined) {
      this.#queue = options.queue;
    } else {
      if (options.connection === undefined) {
        throw new TypeError("connection is required when queue is not injected");
      }
      this.#queue = new Queue<ReviewRequest, unknown, "review">(
        options.queueName ?? "pull-request-reviews",
        { connection: options.connection },
      );
    }
  }

  async enqueue(request: ReviewRequest): Promise<void> {
    const shouldQueue = await this.#stateStore.recordRequested(
      request.repository,
      request.pullRequestNumber,
      request.headSha,
    );
    if (!shouldQueue) return;

    const deduplicationId = createHash("sha256")
      .update(reviewConcurrencyKey(request.repository, request.pullRequestNumber))
      .digest("hex");
    const jobId = createHash("sha256").update(request.deliveryId).digest("hex");
    try {
      await this.#queue.add("review", Object.freeze({ ...request }), {
        jobId,
        delay: this.#debounceMs,
        deduplication: {
          id: deduplicationId,
          ttl: this.#debounceMs,
          extend: true,
          replace: true,
          keepLastIfActive: true,
        },
        attempts: 3,
        backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: { age: 7 * 24 * 60 * 60, count: 10_000 },
        removeOnFail: { age: 30 * 24 * 60 * 60, count: 10_000 },
        sizeLimit: 16 * 1024,
        stackTraceLimit: 5,
      });
    } catch (error) {
      await this.#stateStore.enqueueFailed(
        request.repository,
        request.pullRequestNumber,
        request.headSha,
      );
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.#queue.close();
  }
}
