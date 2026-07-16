import type { ReviewRequest } from "./review-queue.js";
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
    const started = await this.#stateStore.tryStart(
      request.repository,
      request.pullRequestNumber,
      request.headSha,
    );
    if (!started) return "superseded";

    const lease: ReviewJobLease = Object.freeze({
      request,
      canPublish: () =>
        this.#stateStore.canPublish(
          request.repository,
          request.pullRequestNumber,
          request.headSha,
        ),
    });
    try {
      await process(lease);
      const completed = await this.#stateStore.complete(
        request.repository,
        request.pullRequestNumber,
        request.headSha,
      );
      return completed ? "completed" : "superseded";
    } catch (error) {
      await this.#stateStore.fail(
        request.repository,
        request.pullRequestNumber,
        request.headSha,
      );
      throw error;
    }
  }
}
