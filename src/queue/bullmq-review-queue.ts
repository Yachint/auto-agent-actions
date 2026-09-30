import { createHash } from "node:crypto";

import { Queue, type ConnectionOptions, type JobsOptions } from "bullmq";

import {
  validateQueuedReviewRequest,
  reviewScope,
  type ReviewQueue,
  type ReviewRequest,
} from "./review-queue.js";
import { type ReviewStateStore } from "./review-state.js";

interface QueueLike {
  getJob?(
    id: string,
  ): Promise<
    { getState(): Promise<string>; remove(): Promise<void> } | undefined
  >;
  add(
    name: "review",
    data: ReviewRequest,
    options: JobsOptions,
  ): Promise<unknown>;
  close(): Promise<void>;
}

export interface BullMqReviewQueueOptions {
  readonly connection?: ConnectionOptions;
  readonly queueName?: string;
  readonly debounceMs?: number;
  readonly queue?: QueueLike;
  readonly stateStore: ReviewStateStore;
  readonly policyHash?: string;
  readonly onQueued?: (request: ReviewRequest) => Promise<void>;
}

export class BullMqReviewQueue implements ReviewQueue {
  readonly #queue: QueueLike;
  readonly #stateStore: ReviewStateStore;
  readonly #debounceMs: number;
  readonly #policyHash: string;
  readonly #onQueued: BullMqReviewQueueOptions["onQueued"];

  constructor(options: BullMqReviewQueueOptions) {
    this.#onQueued = options.onQueued;
    this.#stateStore = options.stateStore;
    this.#policyHash = options.policyHash ?? "pipeline-v2";
    this.#debounceMs = options.debounceMs ?? 1_000;
    if (!Number.isSafeInteger(this.#debounceMs) || this.#debounceMs < 1) {
      throw new TypeError("debounceMs must be a positive integer");
    }
    if (options.queue !== undefined) {
      this.#queue = options.queue;
    } else {
      if (options.connection === undefined) {
        throw new TypeError(
          "connection is required when queue is not injected",
        );
      }
      this.#queue = new Queue<ReviewRequest, unknown, "review">(
        options.queueName ?? "pull-request-reviews",
        { connection: options.connection },
      );
    }
  }

  async enqueue(value: ReviewRequest): Promise<void> {
    value = validateQueuedReviewRequest(value);
    const previous = await this.#stateStore.get(
      value.repository,
      value.pullRequestNumber,
    );
    if (
      value.rerunNonce === undefined &&
      previous?.schedulingRequest !== undefined
    ) {
      const saved = validateQueuedReviewRequest(
        JSON.parse(previous.schedulingRequest),
      );
      const expected = createHash("sha256")
        .update(
          `${value.headSha}#${value.baseBranch ?? ""}#${value.baseSha ?? ""}#${this.#policyHash}#${saved.rerunNonce ?? ""}`,
        )
        .digest("hex");
      if (
        saved.rerunNonce !== undefined &&
        previous.latestRequestedHeadSha === expected
      )
        value = { ...value, rerunNonce: saved.rerunNonce };
    }
    const request =
      value.baseBranch === undefined && value.rerunNonce === undefined
        ? value
        : {
            ...value,
            scopeSha: createHash("sha256")
              .update(
                `${value.headSha}#${value.baseBranch ?? ""}#${value.baseSha ?? ""}#${this.#policyHash}#${value.rerunNonce ?? ""}`,
              )
              .digest("hex"),
          };
    const shouldQueue = await this.#stateStore.recordRequested(
      request.repository,
      request.pullRequestNumber,
      reviewScope(request),
      undefined,
      JSON.stringify(request),
    );
    if (!shouldQueue) {
      const state = await this.#stateStore.get(
        request.repository,
        request.pullRequestNumber,
      );
      if (
        state === null ||
        state.latestRequestedHeadSha !== reviewScope(request) ||
        state.status === "reviewed"
      )
        return;
      if (this.#queue.getJob === undefined) return;
      if (
        state.status === "running" &&
        Date.now() - Date.parse(state.updatedAt) < 90_000
      )
        return;
      if (
        state.status === "running" &&
        !(await this.#stateStore.recoverExpired(
          request.repository,
          request.pullRequestNumber,
          reviewScope(request),
          new Date(Date.now() - 90_000).toISOString(),
        ))
      )
        return;
    }

    const jobId = createHash("sha256")
      .update(
        `${request.repository}#${request.pullRequestNumber}#${reviewScope(request)}`,
      )
      .digest("hex");
    const existing = await this.#queue.getJob?.(jobId);
    if (existing !== undefined) {
      const jobState = await existing.getState();
      if (jobState !== "failed" && jobState !== "completed") return;
      await existing.remove();
    }
    try {
      await this.#queue.add("review", Object.freeze({ ...request }), {
        jobId,
        delay: this.#debounceMs,
        attempts: 3,
        backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: { age: 7 * 24 * 60 * 60, count: 1_000 },
        removeOnFail: { age: 30 * 24 * 60 * 60, count: 1_000 },
        sizeLimit: 16 * 1024,
        stackTraceLimit: 5,
      });
      await this.#onQueued?.(request);
    } catch (error) {
      await this.#stateStore.enqueueFailed(
        request.repository,
        request.pullRequestNumber,
        reviewScope(request),
      );
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.#queue.close();
  }
}
