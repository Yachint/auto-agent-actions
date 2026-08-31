import type { InstallationTokenProvider } from "../github/app-auth.js";
import { GitHubRestClient, type GitHubReviewClient } from "../github/client.js";
import {
  GitHubReviewPublisher,
  type PublisherOptions,
} from "../github/publisher.js";
import {
  validatePublicationJob,
  validatePublicationRequest,
  type FailurePublicationRequest,
  type PublicationJob,
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

export type PublicationJobResult =
  | "published"
  | "failure-notified"
  | "skipped"
  | "superseded"
  | "ineligible";

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
    const publication = validatePublicationJob(value);
    if ("failureCode" in publication) return this.#publishFailure(publication);
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

  async #publishFailure(publication: FailurePublicationRequest): Promise<PublicationJobResult> {
    const request = publication.reviewRequest;
    if (!this.#dependencies.allowedRepositories.has(request.repository)) {
      throw new TypeError("failure publication repository is not allowlisted");
    }
    const installationToken = await this.#dependencies.tokenProvider.getToken(
      request.installationId,
      request.repository,
      "review-write",
    );
    const client =
      this.#dependencies.createReviewClient?.(installationToken.token) ??
      new GitHubRestClient({ installationToken: installationToken.token });
    const result = await new GitHubReviewPublisher(client, this.#publisherOptions).publishFailure({
      repository: request.repository,
      pullRequestNumber: request.pullRequestNumber,
      headSha: request.headSha,
      failureCode: publication.failureCode,
    });
    if (result.status === "published") return "failure-notified";
    if (result.status === "stale") return "superseded";
    return "ineligible";
  }

  async markFailed(value: unknown): Promise<void> {
    const job: PublicationJob = validatePublicationJob(value);
    if ("failureCode" in job) return;
    const publication: PublicationRequest = validatePublicationRequest(job);
    await this.#dependencies.stateStore.fail(
      publication.reviewRequest.repository,
      publication.reviewRequest.pullRequestNumber,
      publication.reviewRequest.headSha,
    );
  }
}
