import type { ReasoningEffort } from "../codex/runner.js";
import type { InstallationTokenProvider } from "../github/app-auth.js";
import {
  GitHubRestClient,
  type GitHubRepositoryClient,
} from "../github/client.js";
import type { PublicationQueue } from "../queue/publication-queue.js";
import {
  validateQueuedReviewRequest,
  refreshedReviewRequest,
  type ReviewQueue,
  type ReviewRequest,
} from "../queue/review-queue.js";
import type { ReviewStateStore } from "../queue/review-state.js";
import {
  runReviewCore,
  type ReviewCoreOptions,
  type ReviewCoreResult,
} from "./review-core.js";

export interface AnalysisJobOptions {
  readonly dataDirectory: string;
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly timeoutMs: number;
  readonly schemaPath: string;
  readonly instructionsPath: string;
  readonly codexBinary?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface AnalysisJobDependencies {
  readonly allowedRepositories: ReadonlySet<string>;
  readonly stateStore: ReviewStateStore;
  readonly tokenProvider: InstallationTokenProvider;
  readonly reviewQueue: ReviewQueue;
  readonly publicationQueue: PublicationQueue;
  readonly createRepositoryClient?: (token: string) => GitHubRepositoryClient;
  readonly runReview?: (options: ReviewCoreOptions) => Promise<ReviewCoreResult>;
}

export type AnalysisJobResult = "handed-off" | "superseded" | "ineligible";

export class AnalysisJobProcessor {
  readonly #options: AnalysisJobOptions;
  readonly #dependencies: AnalysisJobDependencies;

  constructor(options: AnalysisJobOptions, dependencies: AnalysisJobDependencies) {
    this.#options = options;
    this.#dependencies = dependencies;
  }

  async process(value: unknown): Promise<AnalysisJobResult> {
    const request = validateQueuedReviewRequest(value);
    if (!this.#dependencies.allowedRepositories.has(request.repository)) {
      throw new TypeError("review job repository is not allowlisted");
    }
    const state = this.#dependencies.stateStore;
    const started = await state.tryStart(
      request.repository,
      request.pullRequestNumber,
      request.headSha,
    );
    if (!started) return "superseded";

    try {
      const installationToken = await this.#dependencies.tokenProvider.getToken(
        request.installationId,
        request.repository,
        "repository-read",
      );
      const client =
        this.#dependencies.createRepositoryClient?.(installationToken.token) ??
        new GitHubRestClient({ installationToken: installationToken.token });
      const pullRequest = await client.getPullRequestDetails(
        request.repository,
        request.pullRequestNumber,
      );
      if (
        pullRequest.state !== "open" ||
        pullRequest.draft ||
        pullRequest.baseRepository !== request.repository ||
        pullRequest.headRepository !== request.repository
      ) {
        await state.complete(request.repository, request.pullRequestNumber, request.headSha);
        return "ineligible";
      }
      if (pullRequest.headSha !== request.headSha) {
        await this.#enqueueRefreshed(request, pullRequest.headSha);
        await state.complete(request.repository, request.pullRequestNumber, request.headSha);
        return "superseded";
      }

      const result = await (this.#dependencies.runReview ?? runReviewCore)({
        repository: request.repository,
        remoteUrl: pullRequest.cloneUrl,
        baseBranch: pullRequest.baseBranch,
        pullRequestNumber: request.pullRequestNumber,
        expectedBaseSha: pullRequest.baseSha,
        expectedHeadSha: pullRequest.headSha,
        dataDirectory: this.#options.dataDirectory,
        model: this.#options.model,
        reasoningEffort: this.#options.reasoningEffort,
        timeoutMs: this.#options.timeoutMs,
        schemaPath: this.#options.schemaPath,
        instructionsPath: this.#options.instructionsPath,
        fetchAuthentication: { installationToken: installationToken.token },
        ...(this.#options.codexBinary === undefined
          ? {}
          : { codexBinary: this.#options.codexBinary }),
        ...(this.#options.environment === undefined
          ? {}
          : { environment: this.#options.environment }),
      });
      if (
        !(await state.canPublish(
          request.repository,
          request.pullRequestNumber,
          request.headSha,
        ))
      ) {
        await state.complete(request.repository, request.pullRequestNumber, request.headSha);
        return "superseded";
      }
      await this.#dependencies.publicationQueue.enqueue({
        reviewRequest: request,
        exactDiff: result.exactDiff,
        output: result.review,
      });
      return "handed-off";
    } catch (error) {
      await state.fail(request.repository, request.pullRequestNumber, request.headSha);
      throw error;
    }
  }

  async #enqueueRefreshed(request: ReviewRequest, headSha: string): Promise<void> {
    await this.#dependencies.reviewQueue.enqueue(
      refreshedReviewRequest(request, headSha),
    );
  }
}
