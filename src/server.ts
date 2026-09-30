import { BullMqPublicationQueue } from "./queue/publication-queue.js";
import { workerHealthKey } from "./observability/worker-health.js";
import { reviewPolicyHash } from "./queue/policy.js";
import { createIORedisClient, Queue } from "bullmq";
import { Redis } from "ioredis";

import { buildApp } from "./app.js";
import { loadWebhookServerConfig } from "./config/runtime.js";
import { RedisOperationalMetrics } from "./observability/metrics.js";
import { BullMqReviewQueue } from "./queue/bullmq-review-queue.js";
import { RedisDeliveryClaims } from "./queue/redis-delivery-claims.js";
import { RedisReviewStateStore } from "./queue/redis-review-state.js";

const config = await loadWebhookServerConfig();
const redis = new Redis(config.redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  enableReadyCheck: true,
});
await redis.connect();
const redisClient = createIORedisClient(redis);
const stateStore = new RedisReviewStateStore(redisClient);
const operationalMetrics = new RedisOperationalMetrics(redis);
const reviewMetricsQueue = new Queue(config.reviewQueueName, {
  connection: redis,
});
const publicationMetricsQueue = new Queue(config.publicationQueueName, {
  connection: redis,
});
const statusQueue = new BullMqPublicationQueue({
  connection: redis,
  queueName: config.publicationQueueName,
});
const queue = new BullMqReviewQueue({
  connection: redis,
  queueName: config.reviewQueueName,
  debounceMs: config.reviewQueueDebounceMs,
  stateStore,
  policyHash: reviewPolicyHash(),
  onQueued: (request) =>
    statusQueue.enqueueStatus({ reviewRequest: request, stage: "queued" }),
});
const app = buildApp({
  logLevel: config.logLevel,
  readiness: async () =>
    (await redis.ping()) === "PONG" &&
    (await redis.exists(
      workerHealthKey("analysis"),
      workerHealthKey("publisher"),
    )) === 2,
  metrics: {
    record: (name, increment) => operationalMetrics.record(name, increment),
    snapshot: async () => {
      const [counters, reviewCounts, publicationCounts] = await Promise.all([
        operationalMetrics.snapshot(),
        reviewMetricsQueue.getJobCounts("wait", "delayed", "active", "failed"),
        publicationMetricsQueue.getJobCounts(
          "wait",
          "delayed",
          "active",
          "failed",
        ),
      ]);
      const oldest = async (queue: Queue) => {
        const jobs = await queue.getJobs(["waiting", "delayed"], 0, 0, true);
        return jobs.length === 0
          ? 0
          : Math.max(
              0,
              Date.now() - Math.min(...jobs.map((job) => job.timestamp)),
            );
      };
      const memory = await redis.info("memory");
      return {
        ...counters,
        analysis_worker_ready: await redis.exists(workerHealthKey("analysis")),
        publisher_worker_ready: await redis.exists(
          workerHealthKey("publisher"),
        ),
        review_oldest_pending_ms: await oldest(reviewMetricsQueue),
        publication_oldest_pending_ms: await oldest(publicationMetricsQueue),
        redis_used_memory_bytes: Number(
          /^used_memory:(\d+)/m.exec(memory)?.[1] ?? 0,
        ),
        review_queue_waiting:
          (reviewCounts.wait ?? 0) + (reviewCounts.delayed ?? 0),
        review_queue_active: reviewCounts.active ?? 0,
        review_queue_failed: reviewCounts.failed ?? 0,
        publication_queue_waiting:
          (publicationCounts.wait ?? 0) + (publicationCounts.delayed ?? 0),
        publication_queue_active: publicationCounts.active ?? 0,
        publication_queue_failed: publicationCounts.failed ?? 0,
      };
    },
  },
  webhook: {
    secret: config.webhookSecret,
    allowedRepositories: config.allowedRepositories,
    queue,
    deliveryClaims: new RedisDeliveryClaims(redisClient),
    ...(config.enableCommentCommands ? { commandQueue: statusQueue } : {}),
  },
});
app.addHook("onClose", async () => {
  await statusQueue.close();
  await publicationMetricsQueue.close();
  await reviewMetricsQueue.close();
  await queue.close();
  if (redis.status !== "end") await redis.quit();
});

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
