import { RedisPublicationIntentStore } from "../../src/queue/publication-intents.js";
import { randomUUID } from "node:crypto";
import { createIORedisClient, Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisReviewStateStore } from "../../src/queue/redis-review-state.js";
import { reviewStateRedisKey } from "../../src/queue/review-state.js";
import { BullMqReviewQueue } from "../../src/queue/bullmq-review-queue.js";
import { BullMqPublicationQueue } from "../../src/queue/publication-queue.js";

const enabled = process.env.RUN_REDIS_TEST === "1";
const suffix = randomUUID().replaceAll("-", "");
const repository = `aaa-tests/${suffix}`;
const head = "a".repeat(40);
const next = "b".repeat(40);
let redis: Redis;
let state: RedisReviewStateStore;
const queues: Queue[] = [];
const workers: Worker[] = [];
const request = {
  repository,
  pullRequestNumber: 1,
  installationId: 1,
  headSha: head,
  deliveryId: "test",
  action: "opened" as const,
};

describe.skipIf(!enabled)("real Redis/BullMQ pipeline recovery", () => {
  beforeAll(async () => {
    const url = process.env.AAA_TEST_REDIS_URL;
    if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname))
      throw new Error(
        "AAA_TEST_REDIS_URL must identify a disposable localhost Redis",
      );
    redis = new Redis(url, { maxRetriesPerRequest: null });
    await redis.ping();
    state = new RedisReviewStateStore(createIORedisClient(redis));
  });
  afterAll(async () => {
    for (const worker of workers) await worker.close();
    for (const queue of queues) {
      await queue.obliterate({ force: true });
      await queue.close();
    }
    if (redis) {
      await redis.del(reviewStateRedisKey(repository, 1));
      await redis.quit();
    }
  });

  it("persists publisher intent and receipt across store recreation and analysis scope replacement", async () => {
    const prefix = `aaa-publisher-intents-${suffix}`;
    const intents = new RedisPublicationIntentStore(redis, prefix);
    const id = await intents.prepare({
      repository,
      pullRequestNumber: 1,
      installationId: 1,
      headSha: head,
      baseSha: next,
      scopeSha: head,
      marker: `<!-- auto-agent-actions:review=${"d".repeat(64)} -->`,
    });
    try {
      await intents.recordReviewId(id, 42);
      const original = (await intents.list(10))[0]!;
      await intents.prepare(original);
      await state.recordRequested(repository, 1, next);
      const restarted = new RedisPublicationIntentStore(redis, prefix);
      expect(await restarted.list(10)).toEqual([{ ...original, reviewId: 42 }]);
      await restarted.touch(id);
      await restarted.remove(id);
      expect(await restarted.list(10)).toEqual([]);
    } finally {
      await intents.remove(id);
      await redis.del(prefix);
    }
  });

  it("fences duplicate and expired analysis attempts and releases analysis at handoff", async () => {
    await state.recordRequested(repository, 1, head);
    expect(await state.tryStart(repository, 1, head, "owner-a")).toBe(true);
    expect(await state.tryStart(repository, 1, head, "owner-b")).toBe(false);
    await state.fail(repository, 1, head, "owner-a");
    expect(await state.tryStart(repository, 1, head, "owner-b")).toBe(true);
    expect(await state.handoff(repository, 1, head, "{}", "owner-a")).toBe(
      false,
    );
    expect(await state.handoff(repository, 1, head, "{}", "owner-b")).toBe(
      true,
    );
    expect((await state.get(repository, 1))?.status).toBe("publishing");
    await state.recordRequested(repository, 1, next);
    expect(await state.tryStart(repository, 1, next, "owner-c")).toBe(true);
    expect(await state.canPublish(repository, 1, head)).toBe(false);
    await state.fail(repository, 1, head, "owner-b");
    expect(await state.canPublish(repository, 1, next, "owner-c")).toBe(true);
    await redis.hset(
      reviewStateRedisKey(repository, 1),
      "updated_at",
      "2000-01-01T00:00:00.000Z",
    );
    expect(
      await state.recoverExpired(
        repository,
        1,
        next,
        "2026-01-01T00:00:00.000Z",
      ),
    ).toBe(true);
    expect(await state.tryStart(repository, 1, next, "owner-d")).toBe(true);
    expect(await state.complete(repository, 1, next, "owner-c")).toBe(false);
  });

  it("repairs a state write whose queue insertion never happened", async () => {
    await redis.del(reviewStateRedisKey(repository, 1));
    await state.recordRequested(repository, 1, head);
    const queue = new Queue(`aaa-repair-${suffix}`, { connection: redis });
    queues.push(queue);
    const reviews = new BullMqReviewQueue({
      stateStore: state,
      queue,
      debounceMs: 1,
    });
    await reviews.enqueue(request);
    expect(await queue.getJobCounts("waiting", "delayed")).toMatchObject({
      delayed: 1,
    });
    await reviews.enqueue({ ...request, deliveryId: "duplicate" });
    expect((await queue.getJobs(["waiting", "delayed"])).length).toBe(1);
  });

  it("recreates a retained failed publication without rerunning analysis", async () => {
    const queue = new Queue(`aaa-publication-${suffix}`, { connection: redis });
    queues.push(queue);
    const publications = new BullMqPublicationQueue({
      queue: {
        add: (name, data, options) =>
          queue.add(name, data, { ...options, attempts: 1 }),
        getJob: (id) => queue.getJob(id),
        close: () => queue.close(),
      },
    });
    let succeeds = false;
    const worker = new Worker(
      queue.name,
      async () => {
        if (!succeeds) throw new Error("injected transport failure");
        return "published";
      },
      { connection: redis },
    );
    workers.push(worker);
    const failed = new Promise<void>((resolve) =>
      worker.once("failed", () => resolve()),
    );
    const artifact = {
      reviewRequest: request,
      exactDiff: { baseSha: next, headSha: head, files: [] },
      output: {
        status: "completed" as const,
        blocked_reason: null,
        findings: [],
        summary: "clean",
      },
    };
    await publications.enqueue(artifact);
    await failed;
    succeeds = true;
    const completed = new Promise<void>((resolve) =>
      worker.once("completed", () => resolve()),
    );
    await publications.enqueue(artifact);
    await completed;
    expect(await queue.getJobCounts("failed", "completed")).toMatchObject({
      failed: 0,
      completed: 1,
    });
  });
});
