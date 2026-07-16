import { createHash } from "node:crypto";

import type {
  InstallationTokenProvider,
  RepositoryInstallationProvider,
} from "../github/app-auth.js";
import {
  GitHubRestClient,
  type GitHubPullRequestListClient,
} from "../github/client.js";
import type { ReviewQueue } from "../queue/review-queue.js";

export interface ReconciliationDependencies {
  readonly allowedRepositories: ReadonlySet<string>;
  readonly installationProvider: RepositoryInstallationProvider;
  readonly tokenProvider: InstallationTokenProvider;
  readonly reviewQueue: ReviewQueue;
  readonly createPullRequestClient?: (token: string) => GitHubPullRequestListClient;
}

export interface ReconciliationResult {
  readonly repositoriesChecked: number;
  readonly pullRequestsSeen: number;
  readonly eligiblePullRequests: number;
  readonly repositoriesFailed: readonly string[];
}

export class ReconciliationProcessor {
  readonly #dependencies: ReconciliationDependencies;

  constructor(dependencies: ReconciliationDependencies) {
    if (dependencies.allowedRepositories.size === 0) {
      throw new TypeError("reconciliation requires at least one allowlisted repository");
    }
    this.#dependencies = dependencies;
  }

  async run(): Promise<ReconciliationResult> {
    let pullRequestsSeen = 0;
    let eligiblePullRequests = 0;
    const repositoriesFailed: string[] = [];

    for (const repository of [...this.#dependencies.allowedRepositories].sort()) {
      try {
        const installationId =
          await this.#dependencies.installationProvider.getRepositoryInstallationId(repository);
        const token = await this.#dependencies.tokenProvider.getToken(
          installationId,
          repository,
          "repository-read",
        );
        const client =
          this.#dependencies.createPullRequestClient?.(token.token) ??
          new GitHubRestClient({ installationToken: token.token });
        const pullRequests = await client.listOpenPullRequests(repository);
        pullRequestsSeen += pullRequests.length;
        for (const pullRequest of pullRequests) {
          if (pullRequest.draft || pullRequest.headRepository !== repository) continue;
          eligiblePullRequests += 1;
          await this.#dependencies.reviewQueue.enqueue({
            deliveryId: reconciliationDeliveryId(
              repository,
              pullRequest.pullRequestNumber,
              pullRequest.headSha,
            ),
            installationId,
            repository,
            pullRequestNumber: pullRequest.pullRequestNumber,
            action: "synchronize",
            headSha: pullRequest.headSha,
          });
        }
      } catch {
        repositoriesFailed.push(repository);
      }
    }

    return Object.freeze({
      repositoriesChecked: this.#dependencies.allowedRepositories.size,
      pullRequestsSeen,
      eligiblePullRequests,
      repositoriesFailed: Object.freeze(repositoriesFailed),
    });
  }
}

function reconciliationDeliveryId(
  repository: string,
  pullRequestNumber: number,
  headSha: string,
): string {
  return `reconcile-${createHash("sha256")
    .update(`${repository}#${pullRequestNumber}#${headSha.toLowerCase()}`)
    .digest("hex")}`;
}
