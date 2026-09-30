import { RedisPublicationIntentStore } from "./queue/publication-intents.js";
import { PublicationRepairProcessor } from "./workflows/publication-repair.js";
import { createHash } from "node:crypto";
import { startWorkerHeartbeat } from "./observability/worker-health.js";
import {
  redisPublicationLease,
  PublicationBusyError,
} from "./queue/publication-lease.js";
import { GitHubApiError } from "./github/client.js";
import { reviewPolicyHash } from "./queue/policy.js";
import { createIORedisClient, Worker } from "bullmq";
import { Redis } from "ioredis";
import { pino } from "pino";

import { loadPublisherWorkerConfig } from "./config/runtime.js";
import { GitHubAppAuth } from "./github/app-auth.js";
import { ReadTokenBrokerServer } from "./github/read-token-broker.js";
import { RedisOperationalMetrics } from "./observability/metrics.js";
import {
  BullMqPublicationQueue,
  type PublicationJob,
} from "./queue/publication-queue.js";
import { BullMqReviewQueue } from "./queue/bullmq-review-queue.js";
import { RedisReviewStateStore } from "./queue/redis-review-state.js";
import { PublicationJobProcessor } from "./workflows/publication-job.js";
import { ReconciliationProcessor } from "./workflows/reconciliation.js";

const config = await loadPublisherWorkerConfig();
const logger = pino({ level: config.logLevel });
const redis = new Redis(config.redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});
await redis.connect();
const metrics = new RedisOperationalMetrics(redis);
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
const tokenProvider = new GitHubAppAuth({
  appId: config.appId,
  privateKey: config.privateKey,
  enableChecks: config.enableChecks,
});
const broker = new ReadTokenBrokerServer({
  socketPath: config.brokerSocketPath,
  sharedSecret: config.brokerSharedSecret,
  allowedRepositories: config.allowedRepositories,
  tokenProvider,
});
await broker.listen();
const publicationIntents = new RedisPublicationIntentStore(redis);
let githubBlockedUntil = 0;
const processor = new PublicationJobProcessor(
  {
    allowedRepositories: config.allowedRepositories,
    stateStore,
    tokenProvider,
    appIdentityProvider: tokenProvider,
    publicationIntents,
    reviewQueue,
    enableChecks: config.enableChecks,
    enableCommentCommands: config.enableCommentCommands,
    claimCommandCooldown: async (repository, number, commentId) => {
      const key = `auto-agent-actions:command-cooldown:${createHash("sha256").update(`${repository}#${number}`).digest("hex")}`;
      const value = String(commentId);
      return (
        (await redis.set(key, value, "EX", 600, "NX")) === "OK" ||
        (await redis.get(key)) === value
      );
    },
    withPublicationLease: redisPublicationLease(redis),
  },
  {
    minimumConfidence: config.minimumConfidence,
    blockingPriority: config.blockingPriority,
    findingContinuity: config.findingContinuity,
    maximumInlineComments: config.maximumInlineComments,
    publishEmptySummary: config.publishSummaryWithoutFindings,
  },
);
const worker = new Worker<
  PublicationJob,
  string,
  "publish" | "notify-failure" | "status" | "command"
>(
  config.publicationQueueName,
  async (job) => {
    try {
      const result = await processor.process(job.data);
      await recordMetric(`publication_${result.replaceAll("-", "_")}_total`);
      return result;
    } catch (error) {
      if (
        error instanceof GitHubApiError &&
        error.retryAfterMs === undefined &&
        (error.statusCode === 401 || error.statusCode === 403)
      ) {
        githubBlockedUntil = Date.now() + 300_000;
        await worker.rateLimit(300_000);
        throw Worker.RateLimitError();
      }
      if (
        error instanceof PublicationBusyError ||
        (error instanceof GitHubApiError && error.retryAfterMs !== undefined)
      ) {
        await worker.rateLimit(
          error instanceof GitHubApiError
            ? error.retryAfterMs! + Math.floor(Math.random() * 1000)
            : 5000,
        );
        throw Worker.RateLimitError();
      }
      await recordMetric("publication_failed_total");
      throw error;
    }
  },
  {
    connection: redis,
    concurrency: config.concurrency,
    limiter: { max: 1, duration: 1000 },
  },
);
const repairProcessor = new PublicationRepairProcessor(
  {
    allowedRepositories: config.allowedRepositories,
    stateStore,
    tokenProvider,
    appIdentityProvider: tokenProvider,
    withPublicationLease: redisPublicationLease(redis),
  },
  publicationIntents,
);
let repairRunning = false;
async function repairPublications() {
  if (closing || repairRunning || Date.now() < githubBlockedUntil) return;
  repairRunning = true;
  try {
    await repairProcessor.run();
  } catch (error) {
    if (
      error instanceof GitHubApiError &&
      (error.retryAfterMs !== undefined ||
        error.statusCode === 401 ||
        error.statusCode === 403)
    )
      githubBlockedUntil = Date.now() + (error.retryAfterMs ?? 300_000);
    logger.warn(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "pending publication repair deferred",
    );
  } finally {
    repairRunning = false;
  }
}
const repairTimer = setInterval(() => {
  void repairPublications();
}, 30_000);
repairTimer.unref();
let closing = false;
void repairPublications();
const reconciliation = new ReconciliationProcessor({
  allowedRepositories: config.allowedRepositories,
  installationProvider: tokenProvider,
  onBackoff: (delayMs) => {
    githubBlockedUntil = Date.now() + delayMs;
  },
  tokenProvider,
  reviewQueue,
});
let reconciliationRunning = false;
async function reconcile(): Promise<void> {
  if (reconciliationRunning || closing || Date.now() < githubBlockedUntil)
    return;
  reconciliationRunning = true;
  try {
    const result = await reconciliation.run();
    await recordMetric("reconciliation_runs_total");
    await recordMetric(
      "reconciliation_failed_repositories_total",
      result.repositoriesFailed.length,
    );
    const level = result.repositoriesFailed.length === 0 ? "info" : "warn";
    logger[level](result, "pull request reconciliation completed");
  } catch (error) {
    logger.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "pull request reconciliation failed",
    );
  } finally {
    reconciliationRunning = false;
  }
}

async function recordMetric(name: string, increment?: number): Promise<void> {
  await metrics.record(name, increment).catch((error: unknown) => {
    logger.warn(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "could not record publisher metric",
    );
  });
}
const reconciliationTimer = setInterval(() => {
  void reconcile();
}, config.reconciliationIntervalMs);
reconciliationTimer.unref();
void reconcile();

const stopHeartbeat = startWorkerHeartbeat(
  redis,
  "publisher",
  () => !closing && !worker.isPaused() && Date.now() >= githubBlockedUntil,
);

worker.on("completed", (job, result) => {
  logger.info({ jobId: job.id, result }, "publication job completed");
});
worker.on("failed", (job, error) => {
  logger.error(
    { jobId: job?.id, attemptsMade: job?.attemptsMade, errorName: error.name },
    "publication job failed",
  );
  if (job !== undefined && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    void processor.markFailed(job.data).catch((stateError: unknown) => {
      logger.error(
        {
          errorName: stateError instanceof Error ? stateError.name : "unknown",
        },
        "could not mark publication permanently failed",
      );
    });
  }
});
worker.on("error", (error) => {
  logger.error({ errorName: error.name }, "publication worker error");
});

async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  clearInterval(reconciliationTimer);
  clearInterval(repairTimer);
  const deadline = setTimeout(() => process.exit(1), 30_000);
  deadline.unref();
  await stopHeartbeat();
  await worker.close();
  await broker.close();
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
