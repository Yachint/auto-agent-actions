import type { InstallationTokenProvider } from "../github/app-auth.js";
import { GitHubRestClient, type GitHubReviewClient } from "../github/client.js";
import {
  GitHubReviewPublisher,
  type PublisherOptions,
} from "../github/publisher.js";
import {
  validatePublicationRequest,
  type PublicationRequest,
} from "../queue/publication-queue.js";
import {
  refreshedReviewRequest,
  type ReviewQueue,
} from "../queue/review-queue.js";
import type { ReviewStateStore } from "../queue/review-state.js";

export interface PublicationJobDependencies {
  readonly allowedRepositories: ReadonlySet<string>;
  readonly stateStore: ReviewStateStore;
  readonly tokenProvider: InstallationTokenProvider;
  readonly reviewQueue: ReviewQueue;
  readonly createReviewClient?: (token: string) => GitHubReviewClient;
}

export type PublicationJobResult = "published" | "skipped" | "superseded" | "ineligible";

export class PublicationJobProcessor {
  readonly #dependencies: PublicationJobDependencies;
  readonly #publisherOptions: PublisherOptions;

  constructor(
    dependencies: PublicationJobDependencies,
    publisherOptions: PublisherOptions = {},
  ) {
    this.#dependencies = dependencies;
    this.#publisherOptions = publisherOptions;
  }

  async process(value: unknown): Promise<PublicationJobResult> {
    const publication = validatePublicationRequest(value);
    const request = publication.reviewRequest;
    if (!this.#dependencies.allowedRepositories.has(request.repository)) {
      throw new TypeError("publication repository is not allowlisted");
    }
    if (
      !(await this.#dependencies.stateStore.canPublish(
        request.repository,
        request.pullRequestNumber,
        request.headSha,
      ))
    ) {
      await this.#dependencies.stateStore.complete(
        request.repository,
        request.pullRequestNumber,
        request.headSha,
      );
      return "superseded";
    }

    const installationToken = await this.#dependencies.tokenProvider.getToken(
      request.installationId,
      request.repository,
      "review-write",
    );
    const client =
      this.#dependencies.createReviewClient?.(installationToken.token) ??
      new GitHubRestClient({ installationToken: installationToken.token });
    const result = await new GitHubReviewPublisher(client, this.#publisherOptions).publish({
      repository: request.repository,
      pullRequestNumber: request.pullRequestNumber,
      reviewedHeadSha: request.headSha,
      exactDiff: publication.exactDiff,
      output: publication.output,
    });

    if (result.status === "stale") {
      await this.#dependencies.reviewQueue.enqueue(
        refreshedReviewRequest(request, result.currentHeadSha),
      );
      await this.#dependencies.stateStore.complete(
        request.repository,
        request.pullRequestNumber,
        request.headSha,
      );
      return "superseded";
    }

    await this.#dependencies.stateStore.complete(
      request.repository,
      request.pullRequestNumber,
      request.headSha,
    );
    if (result.status === "published") return "published";
    if (result.status === "skipped") return "skipped";
    return "ineligible";
  }

  async markFailed(value: unknown): Promise<void> {
    const publication: PublicationRequest = validatePublicationRequest(value);
    await this.#dependencies.stateStore.fail(
      publication.reviewRequest.repository,
      publication.reviewRequest.pullRequestNumber,
      publication.reviewRequest.headSha,
    );
  }
}
