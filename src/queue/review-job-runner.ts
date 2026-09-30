import { randomUUID } from "node:crypto";
import { reviewScope, type ReviewRequest } from "./review-queue.js";
import type { ReviewStateStore } from "./review-state.js";

export interface ReviewJobLease {
  readonly request: ReviewRequest;
  canPublish(): Promise<boolean>;
}

export type ReviewJobResult = "completed" | "superseded";

export class ReviewJobRunner {
  readonly #stateStore: ReviewStateStore;

  constructor(stateStore: ReviewStateStore) {
    this.#stateStore = stateStore;
  }

  async run(
    request: ReviewRequest,
    process: (lease: ReviewJobLease) => Promise<void>,
  ): Promise<ReviewJobResult> {
    const attemptId = randomUUID();
    const started = await this.#stateStore.tryStart(
      request.repository,
      request.pullRequestNumber,
      reviewScope(request),
      attemptId,
    );
    if (!started) return "superseded";

    const lease: ReviewJobLease = Object.freeze({
      request,
      canPublish: () =>
        this.#stateStore.canPublish(
          request.repository,
          request.pullRequestNumber,
          reviewScope(request),
          attemptId,
        ),
    });
    try {
      await process(lease);
      const completed = await this.#stateStore.complete(
        request.repository,
        request.pullRequestNumber,
        reviewScope(request),
        attemptId,
      );
      return completed ? "completed" : "superseded";
    } catch (error) {
      await this.#stateStore.fail(
        request.repository,
        request.pullRequestNumber,
        reviewScope(request),
        attemptId,
      );
      throw error;
    }
  }
}
