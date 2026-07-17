import { createIORedisClient, Worker } from "bullmq";
import { Redis } from "ioredis";
import { pino } from "pino";

import { loadPublisherWorkerConfig } from "./config/runtime.js";
import { GitHubAppAuth } from "./github/app-auth.js";
import { ReadTokenBrokerServer } from "./github/read-token-broker.js";
import { RedisOperationalMetrics } from "./observability/metrics.js";
import {
  BullMqPublicationQueue,
  type PublicationRequest,
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
});
const publicationQueue = new BullMqPublicationQueue({
  connection: redis,
  queueName: config.publicationQueueName,
});
const tokenProvider = new GitHubAppAuth({
  appId: config.appId,
  privateKey: config.privateKey,
});
const broker = new ReadTokenBrokerServer({
  socketPath: config.brokerSocketPath,
  sharedSecret: config.brokerSharedSecret,
  allowedRepositories: config.allowedRepositories,
  tokenProvider,
});
await broker.listen();
const processor = new PublicationJobProcessor(
  {
    allowedRepositories: config.allowedRepositories,
    stateStore,
    tokenProvider,
    reviewQueue,
  },
  {
    minimumConfidence: config.minimumConfidence,
    maximumInlineComments: config.maximumInlineComments,
    publishEmptySummary: config.publishSummaryWithoutFindings,
  },
);
const worker = new Worker<PublicationRequest, string, "publish">(
  config.publicationQueueName,
  async (job) => {
    try {
      const result = await processor.process(job.data);
      await recordMetric(`publication_${result}_total`);
      return result;
    } catch (error) {
      await recordMetric("publication_failed_total");
      throw error;
    }
  },
  { connection: redis, concurrency: config.concurrency },
);
let closing = false;
const reconciliation = new ReconciliationProcessor({
  allowedRepositories: config.allowedRepositories,
  installationProvider: tokenProvider,
  tokenProvider,
  reviewQueue,
});
let reconciliationRunning = false;
async function reconcile(): Promise<void> {
  if (reconciliationRunning || closing) return;
  reconciliationRunning = true;
  try {
    const result = await reconciliation.run();
    await recordMetric("reconciliation_runs_total");
    await recordMetric("reconciliation_failed_repositories_total", result.repositoriesFailed.length);
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
        { errorName: stateError instanceof Error ? stateError.name : "unknown" },
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
  await worker.close();
  await broker.close();
  await publicationQueue.close();
  await reviewQueue.close();
  if (redis.status !== "end") await redis.quit();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void close().then(() => {
      process.exitCode = 0;
    });
  });
}
