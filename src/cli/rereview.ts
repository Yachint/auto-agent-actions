import { randomUUID } from "node:crypto";
import { createIORedisClient } from "bullmq";
import { Redis } from "ioredis";
import { BullMqReviewQueue } from "../queue/bullmq-review-queue.js";
import { RedisReviewStateStore } from "../queue/redis-review-state.js";
import { reviewPolicyHash } from "../queue/policy.js";
import { validateQueuedReviewRequest } from "../queue/review-queue.js";

const [repository, number, installation, headSha, baseBranch, baseSha] =
  process.argv.slice(2);
if (process.argv.length !== 8 || !process.env.REDIS_URL)
  throw new TypeError(
    "usage: npm run review:rereview -- <owner/repo> <PR> <installation> <head SHA> <base branch> <base SHA>; REDIS_URL required",
  );
if (
  !(process.env.GITHUB_ALLOWED_REPOSITORIES ?? "")
    .split(",")
    .map((value) => value.trim())
    .includes(repository!)
)
  throw new TypeError("repository is not allowlisted");
const request = validateQueuedReviewRequest({
  repository,
  pullRequestNumber: Number(number),
  installationId: Number(installation),
  headSha,
  baseBranch,
  baseSha,
  action: "synchronize",
  deliveryId: `operator-${randomUUID()}`,
  rerunNonce: randomUUID(),
});
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3 });
const queue = new BullMqReviewQueue({
  connection: redis,
  queueName: process.env.REVIEW_QUEUE_NAME ?? "pull-request-reviews",
  stateStore: new RedisReviewStateStore(createIORedisClient(redis)),
  policyHash: reviewPolicyHash(),
});
try {
  await queue.enqueue(request);
  process.stdout.write(
    "Re-review scheduled; analysis will verify the current GitHub scope\n",
  );
} finally {
  await queue.close();
  await redis.quit();
}
