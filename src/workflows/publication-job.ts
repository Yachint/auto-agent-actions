import type { PublicationIntentStore } from "../queue/publication-intents.js";
import { createHash } from "node:crypto";
import type {
  GitHubAppIdentityProvider,
  InstallationTokenProvider,
} from "../github/app-auth.js";
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
  reviewScope,
  type ReviewQueue,
} from "../queue/review-queue.js";
import type { ReviewStateStore } from "../queue/review-state.js";

export interface PublicationJobDependencies {
  readonly allowedRepositories: ReadonlySet<string>;
  readonly stateStore: ReviewStateStore;
  readonly tokenProvider: InstallationTokenProvider;
  readonly appIdentityProvider?: GitHubAppIdentityProvider;
  readonly reviewQueue: ReviewQueue;
  readonly publicationIntents?: PublicationIntentStore;
  readonly enableChecks?: boolean;
  readonly enableCommentCommands?: boolean;
  readonly claimCommandCooldown?: (
    repository: string,
    number: number,
    commentId: number,
  ) => Promise<boolean>;
  readonly withPublicationLease?: <T>(
    repository: string,
    number: number,
    action: (assertOwned: () => Promise<void>) => Promise<T>,
  ) => Promise<T>;
  readonly createReviewClient?: (token: string) => GitHubReviewClient;
}

export type PublicationJobResult =
  | "published"
  | "failure-notified"
  | "skipped"
  | "superseded"
  | "ineligible"
  | "rereview-scheduled";

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
    const request = validatePublicationJob(value).reviewRequest;
    try {
      if (this.#dependencies.withPublicationLease !== undefined)
        return await this.#dependencies.withPublicationLease(
          request.repository,
          request.pullRequestNumber,
          (assertOwned) => this.#process(value, assertOwned),
        );
      return await this.#process(value);
    } catch (error) {
      if (error instanceof SupersededPublicationError) return "superseded";
      throw error;
    }
  }

  async #process(
    value: unknown,
    assertOwned?: () => Promise<void>,
  ): Promise<PublicationJobResult> {
    const publication = validatePublicationJob(value);
    if ("commentId" in publication)
      return this.#publishCommand(publication, assertOwned);
    if ("stage" in publication)
      return this.#publishStatus(publication, assertOwned);
    if ("failureCode" in publication)
      return this.#publishFailure(publication, assertOwned);
    const request = publication.reviewRequest;
    if (!this.#dependencies.allowedRepositories.has(request.repository)) {
      throw new TypeError("publication repository is not allowlisted");
    }
    if (
      !(await this.#dependencies.stateStore.canPublish(
        request.repository,
        request.pullRequestNumber,
        reviewScope(request),
      ))
    ) {
      await this.#dependencies.stateStore.complete(
        request.repository,
        request.pullRequestNumber,
        reviewScope(request),
      );
      return "superseded";
    }

    const artifactState = await this.#dependencies.stateStore.get(
      request.repository,
      request.pullRequestNumber,
    );
    if (
      artifactState?.status !== "publishing" ||
      artifactState.publicationArtifact === undefined
    )
      return "superseded";
    if (
      JSON.stringify(
        validatePublicationRequest(
          JSON.parse(artifactState.publicationArtifact),
        ),
      ) !== JSON.stringify(publication)
    )
      throw new TypeError(
        "publication does not match its durable validated artifact",
      );
    const installationToken = await this.#dependencies.tokenProvider.getToken(
      request.installationId,
      request.repository,
      "review-write",
    );
    const client = await this.#client(installationToken.token);
    let intentId: string | undefined;
    const result = await new GitHubReviewPublisher(client, {
      ...this.#publisherOptions,
      onBeforeRetire: async () => {
        await assertOwned?.();
      },
      onBeforeReviewCreate: async (marker, blocking) => {
        if (blocking && this.#dependencies.publicationIntents)
          intentId = await this.#dependencies.publicationIntents.prepare({
            repository: request.repository,
            pullRequestNumber: request.pullRequestNumber,
            installationId: request.installationId,
            headSha: request.headSha,
            baseSha: publication.exactDiff.baseSha,
            ...(request.baseBranch === undefined
              ? {}
              : { baseBranch: request.baseBranch }),
            scopeSha: reviewScope(request),
            marker,
          });
      },
      onReviewCreated: async (reviewId) => {
        if (intentId)
          await this.#dependencies.publicationIntents!.recordReviewId(
            intentId,
            reviewId,
          );
      },
      onBeforeWrite: async () => {
        await assertOwned?.();
        if (
          !(await this.#dependencies.stateStore.canPublish(
            request.repository,
            request.pullRequestNumber,
            reviewScope(request),
          ))
        )
          throw new SupersededPublicationError();
      },
      ...(this.#dependencies.enableChecks
        ? {
            onOutcome: async (outcome: {
              blocking: boolean;
              incomplete: boolean;
              findings: number;
            }) => {
              if (
                !(await this.#dependencies.stateStore.canPublish(
                  request.repository,
                  request.pullRequestNumber,
                  reviewScope(request),
                ))
              )
                return;
              await assertOwned?.();
              await client.setCheckStatus?.(
                request.repository,
                request.headSha,
                reviewScope(request),
                {
                  status: "completed",
                  conclusion: outcome.incomplete
                    ? "action_required"
                    : outcome.blocking
                      ? "failure"
                      : outcome.findings > 0
                        ? "neutral"
                        : "success",
                },
              );
            },
          }
        : {}),
    }).publish({
      repository: request.repository,
      pullRequestNumber: request.pullRequestNumber,
      reviewedHeadSha: request.headSha,
      scopeSha: reviewScope(request),
      exactDiff: publication.exactDiff,
      output: publication.output,
      ...(publication.rejectedFindingCount === undefined
        ? {}
        : { rejectedFindingCount: publication.rejectedFindingCount }),
      ...(request.baseBranch === undefined
        ? {}
        : { reviewedBaseBranch: request.baseBranch }),
    });

    if (result.status === "stale") {
      await this.#dependencies.reviewQueue.enqueue(
        refreshedReviewRequest(
          request,
          result.currentHeadSha,
          result.currentBaseBranch,
          result.currentBaseSha,
        ),
      );
      await this.#dependencies.stateStore.complete(
        request.repository,
        request.pullRequestNumber,
        reviewScope(request),
      );
      return "superseded";
    }

    if (result.status === "published")
      await this.#dependencies.stateStore.recordReceipt(
        request.repository,
        request.pullRequestNumber,
        reviewScope(request),
        result.reviewId,
      );
    if (result.status === "ineligible")
      await this.#dependencies.stateStore.fail(
        request.repository,
        request.pullRequestNumber,
        reviewScope(request),
      );
    else {
      const completed = await this.#dependencies.stateStore.complete(
        request.repository,
        request.pullRequestNumber,
        reviewScope(request),
      );
      if (completed && intentId)
        await this.#dependencies.publicationIntents!.remove(intentId);
    }
    if (result.status === "published") return "published";
    if (result.status === "skipped") return "skipped";
    return "ineligible";
  }

  async #publishCommand(
    command: import("../queue/publication-queue.js").CommentCommandRequest,
    assertOwned?: () => Promise<void>,
  ): Promise<PublicationJobResult> {
    const request = command.reviewRequest;
    if (!this.#dependencies.allowedRepositories.has(request.repository))
      throw new TypeError("command repository is not allowlisted");
    if (!this.#dependencies.enableCommentCommands) return "skipped";
    const token = await this.#dependencies.tokenProvider.getToken(
      request.installationId,
      request.repository,
      "review-write",
    );
    const client = await this.#client(token.token);
    if (!client.getReviewCommand || !client.canRequestReview)
      throw new TypeError("command authorization is unavailable");
    const comment = await client.getReviewCommand(
      request.repository,
      request.pullRequestNumber,
      command.commentId,
    );
    const age = Date.now() - Date.parse(comment.createdAt);
    if (
      comment.body.trim() !== "/codex-review" ||
      comment.userType !== "User" ||
      !Number.isFinite(age) ||
      age < -300_000 ||
      age > 86_400_000 ||
      !(await client.canRequestReview(request.repository, comment.login))
    )
      return "skipped";
    const pull = await client.getPullRequest(
      request.repository,
      request.pullRequestNumber,
    );
    if (
      pull.state !== "open" ||
      pull.draft ||
      pull.headRepository !== request.repository
    )
      return "ineligible";
    if (pull.baseSha === undefined || pull.baseBranch === undefined)
      throw new TypeError("command PR scope is incomplete");
    await assertOwned?.();
    if (
      this.#dependencies.claimCommandCooldown === undefined ||
      !(await this.#dependencies.claimCommandCooldown(
        request.repository,
        request.pullRequestNumber,
        command.commentId,
      ))
    )
      return "skipped";
    await this.#dependencies.reviewQueue.enqueue({
      ...refreshedReviewRequest(
        request,
        pull.headSha,
        pull.baseBranch,
        pull.baseSha,
      ),
      deliveryId: `command-${command.commentId}`,
      rerunNonce: createHash("sha256")
        .update(
          `${request.repository}#${request.pullRequestNumber}#${command.commentId}`,
        )
        .digest("hex"),
    });
    return "rereview-scheduled";
  }

  async #publishStatus(
    publication: import("../queue/publication-queue.js").StatusPublicationRequest,
    assertOwned?: () => Promise<void>,
  ): Promise<PublicationJobResult> {
    const request = publication.reviewRequest;
    if (!this.#dependencies.allowedRepositories.has(request.repository))
      throw new TypeError("status repository is not allowlisted");
    if (!this.#dependencies.enableChecks) return "skipped";
    const current = await this.#dependencies.stateStore.get(
      request.repository,
      request.pullRequestNumber,
    );
    if (
      current?.latestRequestedHeadSha !== reviewScope(request) ||
      current.status !== publication.stage
    )
      return "superseded";
    const token = await this.#dependencies.tokenProvider.getToken(
      request.installationId,
      request.repository,
      "review-write",
    );
    const client = await this.#client(token.token);
    const pull = await client.getPullRequest(
      request.repository,
      request.pullRequestNumber,
    );
    if (
      pull.headSha !== request.headSha ||
      pull.state !== "open" ||
      pull.draft ||
      pull.headRepository !== request.repository ||
      (request.baseBranch !== undefined &&
        (pull.baseBranch !== request.baseBranch ||
          pull.baseSha !== request.baseSha))
    )
      return "superseded";
    await assertOwned?.();
    const latest = await this.#dependencies.stateStore.get(
      request.repository,
      request.pullRequestNumber,
    );
    if (
      latest?.latestRequestedHeadSha !== reviewScope(request) ||
      latest.status !== publication.stage
    )
      return "superseded";
    await client.setCheckStatus?.(
      request.repository,
      request.headSha,
      reviewScope(request),
      { status: publication.stage === "queued" ? "queued" : "in_progress" },
    );
    return "published";
  }

  async #publishFailure(
    publication: FailurePublicationRequest,
    assertOwned?: () => Promise<void>,
  ): Promise<PublicationJobResult> {
    const request = publication.reviewRequest;
    if (!this.#dependencies.allowedRepositories.has(request.repository)) {
      throw new TypeError("failure publication repository is not allowlisted");
    }
    const current = await this.#dependencies.stateStore.get(
      request.repository,
      request.pullRequestNumber,
    );
    if (
      current?.latestRequestedHeadSha !== reviewScope(request) ||
      current.status !== "failed" ||
      (current.attemptId !== undefined &&
        current.attemptId !== publication.attemptId)
    )
      return "superseded";
    const installationToken = await this.#dependencies.tokenProvider.getToken(
      request.installationId,
      request.repository,
      "review-write",
    );
    const client = await this.#client(installationToken.token);
    const result = await new GitHubReviewPublisher(client, {
      ...this.#publisherOptions,
      onBeforeWrite: async () => {
        await assertOwned?.();
        const latest = await this.#dependencies.stateStore.get(
          request.repository,
          request.pullRequestNumber,
        );
        if (
          latest?.latestRequestedHeadSha !== reviewScope(request) ||
          latest.status !== "failed" ||
          (latest.attemptId !== undefined &&
            latest.attemptId !== publication.attemptId)
        )
          throw new SupersededPublicationError();
      },
    }).publishFailure({
      repository: request.repository,
      pullRequestNumber: request.pullRequestNumber,
      headSha: request.headSha,
      failureCode: publication.failureCode,
    });
    if (result.status === "published") {
      if (this.#dependencies.enableChecks)
        await client.setCheckStatus?.(
          request.repository,
          request.headSha,
          reviewScope(request),
          { status: "completed", conclusion: "failure" },
        );
      return "failure-notified";
    }
    if (result.status === "stale") return "superseded";
    return "ineligible";
  }

  async #client(token: string): Promise<GitHubReviewClient> {
    return createPublisherClient(this.#dependencies, token);
  }

  async markFailed(value: unknown): Promise<void> {
    const job: PublicationJob = validatePublicationJob(value);
    if ("failureCode" in job || "stage" in job || "commentId" in job) return;
    const publication: PublicationRequest = validatePublicationRequest(job);
    const current = await this.#dependencies.stateStore.get(
      publication.reviewRequest.repository,
      publication.reviewRequest.pullRequestNumber,
    );
    if (
      current?.status === "publishing" &&
      current.publicationArtifact !== undefined
    )
      return;
    await this.#dependencies.stateStore.fail(
      publication.reviewRequest.repository,
      publication.reviewRequest.pullRequestNumber,
      reviewScope(publication.reviewRequest),
    );
  }
}

class SupersededPublicationError extends Error {}

export async function createPublisherClient(
  dependencies: Pick<
    PublicationJobDependencies,
    "createReviewClient" | "appIdentityProvider"
  >,
  token: string,
): Promise<GitHubReviewClient> {
  if (dependencies.createReviewClient)
    return dependencies.createReviewClient(token);
  if (!dependencies.appIdentityProvider)
    throw new TypeError("publisher App identity provider is required");
  return new GitHubRestClient({
    installationToken: token,
    appIdentity: await dependencies.appIdentityProvider.getAppIdentity(),
  });
}
