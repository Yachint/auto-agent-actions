import { describe, expect, it, vi } from "vitest";

import { RedisDeliveryClaims } from "../../src/queue/redis-delivery-claims.js";
import {
  RedisReviewStateStore,
  type RedisScriptClient,
} from "../../src/queue/redis-review-state.js";

const headSha = "a".repeat(40);

function redisClient(overrides: Partial<RedisScriptClient> = {}): RedisScriptClient {
  return {
    defineCommand: vi.fn(),
    runCommand: vi.fn().mockResolvedValue(1),
    hgetall: vi.fn().mockResolvedValue({}),
    del: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
}

describe("Redis review state adapter", () => {
  it("registers atomic transition scripts and uses opaque per-PR keys", async () => {
    const redis = redisClient();
    const store = new RedisReviewStateStore(redis, () => new Date("2026-07-16T12:00:00Z"));

    await expect(store.recordRequested("owner/project", 7, headSha)).resolves.toBe(true);
    expect(redis.defineCommand).toHaveBeenCalledTimes(6);
    expect(redis.runCommand).toHaveBeenCalledWith(
      "autoAgentRecordReviewRequest",
      [
        expect.stringMatching(/^auto-agent-actions:review-state:[0-9a-f]{64}$/),
        "owner/project",
        "7",
        headSha,
        "2026-07-16T12:00:00.000Z",
      ],
    );
    expect((redis.runCommand as ReturnType<typeof vi.fn>).mock.calls[0]![1][0]).not.toContain(
      "owner/project",
    );
  });

  it("parses durable state and fails closed on invalid stored values", async () => {
    const redis = redisClient({
      hgetall: vi.fn().mockResolvedValue({
        repository: "owner/project",
        pull_request_number: "7",
        latest_requested_head_sha: headSha,
        last_reviewed_head_sha: headSha,
        status: "reviewed",
        updated_at: "2026-07-16T12:00:00.000Z",
      }),
    });
    const store = new RedisReviewStateStore(redis);
    await expect(store.get("owner/project", 7)).resolves.toEqual({
      repository: "owner/project",
      pullRequestNumber: 7,
      latestRequestedHeadSha: headSha,
      currentlyRunningHeadSha: null,
      lastReviewedHeadSha: headSha,
      status: "reviewed",
      updatedAt: "2026-07-16T12:00:00.000Z",
    });

    (redis.hgetall as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ status: "corrupt" });
    await expect(store.get("owner/project", 7)).rejects.toThrow(/invalid review status/);
  });

  it("stores delivery claims with a TTL and releases them by opaque key", async () => {
    const runCommand = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const redis = redisClient({ runCommand });
    const claims = new RedisDeliveryClaims(redis, 3_600);
    await expect(claims.claim("delivery-1")).resolves.toBe(true);
    await expect(claims.claim("delivery-1")).resolves.toBe(false);
    expect(runCommand).toHaveBeenCalledWith("autoAgentClaimWebhookDelivery", [
      expect.stringMatching(/^auto-agent-actions:webhook-delivery:[0-9a-f]{64}$/),
      "3600",
    ]);
    await claims.release("delivery-1");
    expect(redis.del).toHaveBeenCalledWith(
      expect.stringMatching(/^auto-agent-actions:webhook-delivery:[0-9a-f]{64}$/),
    );
  });
});
