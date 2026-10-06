import { randomUUID } from "node:crypto";

import type { ReasoningEffort } from "../codex/runner.js";
import type { InstallationTokenProvider } from "../github/app-auth.js";
import {
  GitHubRestClient,
  type GitHubRepositoryClient,
} from "../github/client.js";
import {
  validatePublicationRequest,
  type PublicationQueue,
} from "../queue/publication-queue.js";
import {
  validateQueuedReviewRequest,
  refreshedReviewRequest,
  reviewScope,
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
  readonly sandboxBinary?: string;
  readonly verifyFindings?: boolean;
  readonly adaptiveEffort?: boolean;
  readonly agentThreads?: 1 | 2 | 3;
  readonly batchFiles?: number;
}

export interface AnalysisJobDependencies {
  readonly allowedRepositories: ReadonlySet<string>;
  readonly stateStore: ReviewStateStore;
  readonly tokenProvider: InstallationTokenProvider;
  readonly reviewQueue: ReviewQueue;
  readonly publicationQueue: PublicationQueue;
  readonly onUsage?: (usage: import("../codex/usage.js").CodexUsage) => void;
  readonly onBatchProgress?: (completed: number, total: number, reused: boolean) => void;
  readonly onRejectedFindings?: (count: number) => void;
  readonly createRepositoryClient?: (token: string) => GitHubRepositoryClient;
  readonly runReview?: (
    options: ReviewCoreOptions,
  ) => Promise<ReviewCoreResult>;
}

export type AnalysisJobResult = "handed-off" | "superseded" | "ineligible";

export class AnalysisAttemptError extends Error {
  constructor(
    readonly attemptId: string,
    override readonly cause: unknown,
  ) {
    super("analysis attempt failed", { cause });
    this.name = "AnalysisAttemptError";
  }
}

export class AnalysisBusyError extends Error {
  constructor() {
    super("analysis lease is held");
    this.name = "AnalysisBusyError";
  }
}

export class AnalysisJobProcessor {
  readonly #controllers = new Set<AbortController>();
  readonly #options: AnalysisJobOptions;
  readonly #dependencies: AnalysisJobDependencies;

  constructor(
    options: AnalysisJobOptions,
    dependencies: AnalysisJobDependencies,
  ) {
    this.#options = options;
    this.#dependencies = dependencies;
  }

  cancelAll(): void {
    for (const controller of this.#controllers) controller.abort();
  }

  async process(value: unknown): Promise<AnalysisJobResult> {
    const request = validateQueuedReviewRequest(value);
    if (!this.#dependencies.allowedRepositories.has(request.repository)) {
      throw new TypeError("review job repository is not allowlisted");
    }
    const state = this.#dependencies.stateStore;
    const pending = await state.get(
      request.repository,
      request.pullRequestNumber,
    );
    if (
      pending?.latestRequestedHeadSha === reviewScope(request) &&
      pending.status === "publishing" &&
      pending.publicationArtifact !== undefined
    ) {
      await this.#dependencies.publicationQueue.enqueue(
        JSON.parse(pending.publicationArtifact),
      );
      return "handed-off";
    }
    if (
      pending?.status === "running" &&
      pending.latestRequestedHeadSha === reviewScope(request) &&
      Date.now() - Date.parse(pending.updatedAt) >= 90_000
    )
      await state.recoverExpired(
        request.repository,
        request.pullRequestNumber,
        reviewScope(request),
        new Date(Date.now() - 90_000).toISOString(),
      );
    const attemptId = randomUUID();
    const started = await state.tryStart(
      request.repository,
      request.pullRequestNumber,
      reviewScope(request),
      attemptId,
    );
    if (!started) {
      const current = await state.get(
        request.repository,
        request.pullRequestNumber,
      );
      if (
        current?.latestRequestedHeadSha === reviewScope(request) &&
        current.status === "running"
      )
        throw new AnalysisBusyError();
      return "superseded";
    }
    const controller = new AbortController();
    this.#controllers.add(controller);
    const deadline = setTimeout(
      () => controller.abort(),
      this.#options.timeoutMs + 240_000,
    );
    const monitor = setInterval(() => {
      void state
        .renew(
          request.repository,
          request.pullRequestNumber,
          reviewScope(request),
          attemptId,
        )
        .then((current) => {
          if (!current) controller.abort();
        })
        .catch(() => controller.abort());
    }, 5000);
    deadline.unref();
    monitor.unref();

    try {
      await this.#dependencies.publicationQueue.enqueueStatus?.({
        reviewRequest: request,
        stage: "running",
      });
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
        await state.fail(
          request.repository,
          request.pullRequestNumber,
          reviewScope(request),
          attemptId,
        );
        return "ineligible";
      }
      if (
        pullRequest.headSha !== request.headSha ||
        (request.baseBranch !== undefined &&
          pullRequest.baseBranch !== request.baseBranch) ||
        (request.baseSha !== undefined &&
          pullRequest.baseSha !== request.baseSha)
      ) {
        await this.#enqueueRefreshed(
          request,
          pullRequest.headSha,
          pullRequest.baseBranch,
          pullRequest.baseSha,
        );
        await state.complete(
          request.repository,
          request.pullRequestNumber,
          reviewScope(request),
          attemptId,
        );
        return "superseded";
      }

      const result = await (this.#dependencies.runReview ?? runReviewCore)({
        signal: controller.signal,
        ...(this.#options.agentThreads === undefined ? {} : { agentThreads: this.#options.agentThreads }),
        ...(this.#options.batchFiles === undefined ? {} : { batchFiles: this.#options.batchFiles }),
        ...(this.#options.verifyFindings === undefined
          ? {}
          : { verifyFindings: this.#options.verifyFindings }),
        ...(this.#options.adaptiveEffort === undefined
          ? {}
          : { adaptiveEffort: this.#options.adaptiveEffort }),
        ...(this.#dependencies.onUsage === undefined
          ? {}
          : { onUsage: this.#dependencies.onUsage }),
        ...(this.#dependencies.onBatchProgress === undefined
          ? {}
          : { onBatchProgress: this.#dependencies.onBatchProgress }),
        ...(this.#options.sandboxBinary === undefined
          ? {}
          : { sandboxBinary: this.#options.sandboxBinary }),
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
          reviewScope(request),
          attemptId,
        ))
      ) {
        await state.complete(
          request.repository,
          request.pullRequestNumber,
          reviewScope(request),
          attemptId,
        );
        return "superseded";
      }
      this.#dependencies.onRejectedFindings?.(result.rejectedFindings.length);
      const publication = validatePublicationRequest({
        reviewRequest: { ...request, deliveryId: `artifact-${randomUUID()}` },
        exactDiff: result.exactDiff,
        output: result.review,
        ...(result.rejectedFindings.length === 0
          ? {}
          : { rejectedFindingCount: result.rejectedFindings.length }),
      });
      if (Buffer.byteLength(JSON.stringify(publication)) > 1024 * 1024)
        throw new TypeError("publication artifact exceeds size limit");
      if (
        !(await state.handoff(
          request.repository,
          request.pullRequestNumber,
          reviewScope(request),
          JSON.stringify(publication),
          attemptId,
        ))
      )
        return "superseded";
      await this.#dependencies.publicationQueue.enqueue(publication);
      return "handed-off";
    } catch (error) {
      const current = await state.get(
        request.repository,
        request.pullRequestNumber,
      );
      // A persisted artifact is an outbox: queue failure must not discard it.
      if (current?.status !== "publishing")
        await state.fail(
          request.repository,
          request.pullRequestNumber,
          reviewScope(request),
          attemptId,
        );
      if (
        controller.signal.aborted &&
        current?.latestRequestedHeadSha !== reviewScope(request)
      )
        return "superseded";
      throw new AnalysisAttemptError(attemptId, error);
    } finally {
      clearTimeout(deadline);
      clearInterval(monitor);
      this.#controllers.delete(controller);
    }
  }

  async #enqueueRefreshed(
    request: ReviewRequest,
    headSha: string,
    baseBranch?: string,
    baseSha?: string,
  ): Promise<void> {
    await this.#dependencies.reviewQueue.enqueue(
      refreshedReviewRequest(request, headSha, baseBranch, baseSha),
    );
  }
}
