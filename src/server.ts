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
const reviewMetricsQueue = new Queue(config.reviewQueueName, { connection: redis });
const publicationMetricsQueue = new Queue(config.publicationQueueName, { connection: redis });
const queue = new BullMqReviewQueue({
  connection: redis,
  queueName: config.reviewQueueName,
  debounceMs: config.reviewQueueDebounceMs,
  stateStore,
});
const app = buildApp({
  logLevel: config.logLevel,
  readiness: async () => (await redis.ping()) === "PONG",
  metrics: {
    record: (name, increment) => operationalMetrics.record(name, increment),
    snapshot: async () => {
      const [counters, reviewCounts, publicationCounts] = await Promise.all([
        operationalMetrics.snapshot(),
        reviewMetricsQueue.getJobCounts("wait", "delayed", "active", "failed"),
        publicationMetricsQueue.getJobCounts("wait", "delayed", "active", "failed"),
      ]);
      return {
        ...counters,
        review_queue_waiting: (reviewCounts.wait ?? 0) + (reviewCounts.delayed ?? 0),
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
  },
});
app.addHook("onClose", async () => {
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
