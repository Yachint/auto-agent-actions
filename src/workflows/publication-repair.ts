import type {
  PublicationIntentStore,
  PendingPublicationIntent,
} from "../queue/publication-intents.js";
import {
  createPublisherClient,
  type PublicationJobDependencies,
} from "./publication-job.js";

export class PublicationRepairProcessor {
  constructor(
    readonly dependencies: Pick<
      PublicationJobDependencies,
      | "allowedRepositories"
      | "stateStore"
      | "tokenProvider"
      | "appIdentityProvider"
      | "createReviewClient"
      | "withPublicationLease"
    >,
    readonly intents: PublicationIntentStore,
  ) {}
  async run(): Promise<void> {
    for (const intent of await this.intents.list(10)) {
      try {
        const action = (assertOwned?: () => Promise<void>) =>
          this.#repair(intent, assertOwned);
        if (this.dependencies.withPublicationLease)
          await this.dependencies.withPublicationLease(
            intent.repository,
            intent.pullRequestNumber,
            action,
          );
        else await action();
      } finally {
        await this.intents.touch(intent.id);
      }
    }
  }
  async #repair(
    intent: PendingPublicationIntent,
    assertOwned?: () => Promise<void>,
  ): Promise<void> {
    if (!this.dependencies.allowedRepositories.has(intent.repository))
      throw new TypeError("repair repository is not allowlisted");
    const token = await this.dependencies.tokenProvider.getToken(
      intent.installationId,
      intent.repository,
      "review-write",
    );
    const client = await createPublisherClient(this.dependencies, token.token);
    if (!client.findReview || !client.dismissReview)
      throw new TypeError(
        "publication repair requires verified review recovery",
      );
    const review = await client.findReview(
      intent.repository,
      intent.pullRequestNumber,
      intent.headSha,
      intent.marker,
    );
    if (!review) {
      // A crash before POST also leaves intent. Remove only after a successful lookup
      // confirms no review exists seven days later; API errors retain the journal.
      if (Date.now() - intent.createdAt > 7 * 24 * 60 * 60 * 1000)
        await this.intents.remove(intent.id);
      return;
    }
    if (
      review.state === "DISMISSED" ||
      review.state === "COMMENTED" ||
      review.state === "APPROVED"
    ) {
      await this.intents.remove(intent.id);
      return;
    }
    if (review.state !== "CHANGES_REQUESTED")
      throw new TypeError("invalid blocking review recovery state");
    const pull = await client.getPullRequest(
      intent.repository,
      intent.pullRequestNumber,
    );
    const state = await this.dependencies.stateStore.get(
      intent.repository,
      intent.pullRequestNumber,
    );
    const obsolete =
      pull.headSha !== intent.headSha ||
      pull.state !== "open" ||
      pull.draft ||
      pull.headRepository !== intent.repository ||
      (intent.baseBranch !== undefined &&
        (pull.baseBranch !== intent.baseBranch ||
          pull.baseSha !== intent.baseSha)) ||
      (state !== null && state.latestRequestedHeadSha !== intent.scopeSha);
    if (obsolete) {
      await assertOwned?.();
      // Intent is written exclusively by the publisher before a blocking POST.
      // Discovery additionally verifies this App's bot and exact trailing marker.
      await client.dismissReview(
        intent.repository,
        intent.pullRequestNumber,
        review.reviewId,
      );
      await this.intents.remove(intent.id);
    } else if (state?.status === "reviewed")
      await this.intents.remove(intent.id);
    else await this.intents.recordReviewId(intent.id, review.reviewId);
  }
}
