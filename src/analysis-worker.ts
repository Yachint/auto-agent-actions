import { createIORedisClient, Worker } from "bullmq";
import { Redis } from "ioredis";
import { pino } from "pino";

import { loadAnalysisWorkerConfig } from "./config/runtime.js";
import { ReadTokenBrokerClient } from "./github/read-token-broker.js";
import { RedisOperationalMetrics } from "./observability/metrics.js";
import { BullMqPublicationQueue } from "./queue/publication-queue.js";
import { BullMqReviewQueue } from "./queue/bullmq-review-queue.js";
import type { ReviewRequest } from "./queue/review-queue.js";
import { RedisReviewStateStore } from "./queue/redis-review-state.js";
import { RepositoryManager } from "./repositories/manager.js";
import { AnalysisJobProcessor } from "./workflows/analysis-job.js";

const config = await loadAnalysisWorkerConfig();
const logger = pino({ level: config.logLevel });
const redis = new Redis(config.redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});
await redis.connect();
const metrics = new RedisOperationalMetrics(redis);
const abandonedWorktreesRemoved = await new RepositoryManager({
  dataDirectory: config.dataDirectory,
}).cleanupAbandonedWorktrees(
  config.allowedRepositories,
  config.abandonedWorktreeAgeMs,
);
logger.info({ abandonedWorktreesRemoved }, "abandoned worktree cleanup completed");
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
const processor = new AnalysisJobProcessor(
  {
    dataDirectory: config.dataDirectory,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    timeoutMs: config.timeoutMs,
    schemaPath: config.schemaPath,
    instructionsPath: config.instructionsPath,
    codexBinary: config.codexBinary,
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
  },
);
const worker = new Worker<ReviewRequest, string, "review">(
  config.reviewQueueName,
  async (job) => {
    const startedAt = Date.now();
    try {
      const result = await processor.process(job.data);
      await recordMetric(`analysis_${result.replaceAll("-", "_")}_total`);
      return result;
    } catch (error) {
      await recordMetric("analysis_failed_total");
      throw error;
    } finally {
      await recordMetric("analysis_duration_ms_total", Date.now() - startedAt);
      await recordMetric("analysis_duration_count");
    }
  },
  { connection: redis, concurrency: config.concurrency },
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
  await worker.close();
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
