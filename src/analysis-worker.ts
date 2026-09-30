import { verifyIsolationPolicy } from "./codex/isolation-preflight.js";
import { statfs, mkdir } from "node:fs/promises";
import { ModelAuthenticationError } from "./codex/model-proxy.js";
import { startWorkerHeartbeat } from "./observability/worker-health.js";
import { GitHubApiError } from "./github/client.js";
import { reviewPolicyHash } from "./queue/policy.js";
import { createIORedisClient, Worker } from "bullmq";
import { Redis } from "ioredis";
import { pino } from "pino";

import {
  CodexExecutionError,
  verifyCodexReadOnlySandbox,
} from "./codex/runner.js";
import { loadAnalysisWorkerConfig } from "./config/runtime.js";
import { ReadTokenBrokerClient } from "./github/read-token-broker.js";
import { RedisOperationalMetrics } from "./observability/metrics.js";
import { BullMqPublicationQueue } from "./queue/publication-queue.js";
import type { AnalysisFailureCode } from "./queue/publication-queue.js";
import { BullMqReviewQueue } from "./queue/bullmq-review-queue.js";
import type { ReviewRequest } from "./queue/review-queue.js";
import { RedisReviewStateStore } from "./queue/redis-review-state.js";
import { RepositoryManager } from "./repositories/manager.js";
import { StaleReviewRefError } from "./repositories/manager.js";
import {
  AnalysisJobProcessor,
  AnalysisBusyError,
  AnalysisAttemptError,
} from "./workflows/analysis-job.js";

const config = await loadAnalysisWorkerConfig();
const logger = pino({ level: config.logLevel });
await verifyCodexReadOnlySandbox({
  codexBinary: config.codexBinary,
  environment: process.env,
});
logger.info("Codex read-only sandbox preflight passed");
if (config.sandboxBinary !== undefined) {
  await verifyIsolationPolicy(config.sandboxBinary, config.dataDirectory);
  logger.info("per-job isolation preflight passed");
}
const redis = new Redis(config.redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});
await redis.connect();
const metrics = new RedisOperationalMetrics(redis);
await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
const abandonedWorktreesRemoved = await new RepositoryManager({
  dataDirectory: config.dataDirectory,
}).cleanupAbandonedWorktrees(
  config.allowedRepositories,
  config.abandonedWorktreeAgeMs,
);
logger.info(
  { abandonedWorktreesRemoved },
  "abandoned worktree cleanup completed",
);
const stateStore = new RedisReviewStateStore(createIORedisClient(redis));
const reviewQueue = new BullMqReviewQueue({
  connection: redis,
  queueName: config.reviewQueueName,
  stateStore,
  policyHash: reviewPolicyHash(),
});
const publicationQueue = new BullMqPublicationQueue({
  connection: redis,
  queueName: config.publicationQueueName,
});
const processor = new AnalysisJobProcessor(
  {
    dataDirectory: config.dataDirectory,
    model: config.model,
    verifyFindings: config.verifyFindings,
    adaptiveEffort: config.adaptiveEffort,
    reasoningEffort: config.reasoningEffort,
    timeoutMs: config.timeoutMs,
    schemaPath: config.schemaPath,
    instructionsPath: config.instructionsPath,
    codexBinary: config.codexBinary,
    ...(config.sandboxBinary === undefined
      ? {}
      : { sandboxBinary: config.sandboxBinary }),
  },
  {
    allowedRepositories: config.allowedRepositories,
    stateStore,
    tokenProvider: new ReadTokenBrokerClient({
      socketPath: config.brokerSocketPath,
      sharedSecret: config.brokerSharedSecret,
    }),
    reviewQueue,
    publicationQueue,
    onUsage: (usage) => {
      void recordMetric("codex_input_tokens_total", usage.inputTokens);
      void recordMetric(
        "codex_cached_input_tokens_total",
        usage.cachedInputTokens,
      );
      void recordMetric("codex_output_tokens_total", usage.outputTokens);
    },
    onRejectedFindings: (count) => {
      void recordMetric("analysis_rejected_findings_total", count);
    },
  },
);
let authenticationBlockedUntil = 0;
const worker = new Worker<ReviewRequest, string, "review">(
  config.reviewQueueName,
  async (job) => {
    const startedAt = Date.now();
    await metrics
      .observe("analysis_queue_wait_ms", Math.max(0, startedAt - job.timestamp))
      .catch(() => {});
    try {
      const disk = await statfs(config.dataDirectory);
      await metrics
        .gauge(
          "review_disk_available_bytes",
          Math.floor(disk.bavail * disk.bsize),
        )
        .catch(() => {});
      if (disk.bavail * disk.bsize < 200 * 1024 * 1024) {
        await worker.rateLimit(60_000);
        throw Worker.RateLimitError();
      }
      const result = await processor.process(job.data);
      await recordMetric(`analysis_${result.replaceAll("-", "_")}_total`);
      return result;
    } catch (error) {
      const failure =
        error instanceof AnalysisAttemptError ? error.cause : error;
      if (
        error instanceof Error &&
        error.message === "bullmq:rateLimitExceeded"
      )
        throw error;
      if (failure instanceof ModelAuthenticationError) {
        authenticationBlockedUntil = Date.now() + 300_000;
        logger.error(
          { errorName: failure.name },
          "model authentication unavailable; analysis paused for five minutes",
        );
        await worker.rateLimit(300_000);
        throw Worker.RateLimitError();
      }
      if (
        failure instanceof AnalysisBusyError ||
        (failure instanceof GitHubApiError &&
          failure.retryAfterMs !== undefined)
      ) {
        await worker.rateLimit(
          failure instanceof AnalysisBusyError
            ? 5000
            : (failure as GitHubApiError).retryAfterMs! +
                Math.floor(Math.random() * 1000),
        );
        throw Worker.RateLimitError();
      }
      await recordMetric("analysis_failed_total");
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
        await publicationQueue
          .enqueueFailure({
            reviewRequest: job.data,
            failureCode: classifyFailure(failure),
            ...(error instanceof AnalysisAttemptError
              ? { attemptId: error.attemptId }
              : {}),
          })
          .catch(async (publicationError: unknown) => {
            await recordMetric(
              "analysis_failure_notification_enqueue_failed_total",
            );
            logger.error(
              {
                jobId: job.id,
                errorName:
                  publicationError instanceof Error
                    ? publicationError.name
                    : "unknown",
              },
              "could not enqueue terminal analysis failure notification",
            );
          });
      }
      throw error;
    } finally {
      await metrics
        .observe("analysis_duration_ms", Date.now() - startedAt)
        .catch(() => {});
    }
  },
  {
    connection: redis,
    concurrency: config.concurrency,
    limiter: { max: 10, duration: 1000 },
  },
);

function classifyFailure(error: unknown): AnalysisFailureCode {
  if (error instanceof StaleReviewRefError) {
    return error.refName === "base" ? "base-ref-changed" : "head-ref-changed";
  }
  if (error instanceof CodexExecutionError && error.failureKind === "blocked")
    return "inspection-blocked";
  if (error instanceof CodexExecutionError && /timeout/i.test(error.message))
    return "timeout";
  return "analysis-failed";
}

let cleaning = false;
const cleanupTimer = setInterval(() => {
  if (closing || cleaning) return;
  cleaning = true;
  void new RepositoryManager({ dataDirectory: config.dataDirectory })
    .cleanupAbandonedWorktrees(
      config.allowedRepositories,
      config.abandonedWorktreeAgeMs,
    )
    .then((count) => recordMetric("abandoned_worktrees_removed_total", count))
    .catch(() => recordMetric("worktree_cleanup_failed_total"))
    .finally(() => {
      cleaning = false;
    });
}, 3_600_000);
cleanupTimer.unref();
const stopHeartbeat = startWorkerHeartbeat(
  redis,
  "analysis",
  () =>
    !closing && !worker.isPaused() && Date.now() >= authenticationBlockedUntil,
);

worker.on("completed", (job, result) => {
  logger.info({ jobId: job.id, result }, "analysis job completed");
});
worker.on("failed", (job, error) => {
  logger.error(
    { jobId: job?.id, attemptsMade: job?.attemptsMade, errorName: error.name },
    "analysis job failed",
  );
});
worker.on("error", (error) => {
  logger.error({ errorName: error.name }, "analysis worker error");
});

async function recordMetric(name: string, increment?: number): Promise<void> {
  await metrics.record(name, increment).catch((error: unknown) => {
    logger.warn(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "could not record analysis metric",
    );
  });
}

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  clearInterval(cleanupTimer);
  const deadline = setTimeout(() => process.exit(1), 30_000);
  deadline.unref();
  await stopHeartbeat();
  processor.cancelAll();
  await worker.close();
  await publicationQueue.close();
  await reviewQueue.close();
  if (redis.status !== "end") await redis.quit();
  clearTimeout(deadline);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void close().then(() => {
      process.exitCode = 0;
    });
  });
}
