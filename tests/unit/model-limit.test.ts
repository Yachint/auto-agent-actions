import { describe, expect, it, vi } from "vitest";
import { modelLimitFromResponse, ModelUsageLimitError } from "../../src/codex/model-limit.js";
import { ModelResponseObserver } from "../../src/codex/model-response.js";
import { UsageCollector } from "../../src/codex/usage.js";
import { runWithModelCooldown } from "../../src/workflows/model-cooldown.js";
import { ModelCooldownStore } from "../../src/queue/model-cooldown.js";
import { AnalysisAttemptError } from "../../src/workflows/analysis-job.js";
import { reviewResourcePolicy } from "../../src/workflows/review-core.js";
import { loadReviewAgentThreads } from "../../src/config/runtime.js";
import { reviewPolicyHash } from "../../src/queue/policy.js";

describe("model usage backoff", () => {
  const now = Date.parse("2026-10-05T14:14:00Z");
  it("uses an absolute reset timestamp without retaining upstream messages", () => {
    const retryAt = Date.parse("2026-10-05T19:08:00Z");
    const limit = modelLimitFromResponse({ error: { type: "usage_limit_reached", resets_at: retryAt / 1000, message: "private diagnostic" } }, 429, "60", now);
    expect(limit).toMatchObject({ name: "ModelUsageLimitError", retryAt });
    expect(JSON.stringify(limit)).not.toContain("private diagnostic");
    expect(limit?.message).not.toContain("private diagnostic");
  });
  it("distinguishes transient throttling from quota exhaustion and bounds malformed reset data", () => {
    expect(modelLimitFromResponse({}, 429, "90", now)?.retryAt).toBe(now + 90_000);
    expect(modelLimitFromResponse({ error: { code: "insufficient_quota" } }, 429, null, now)?.retryAt).toBe(now + 18_000_000);
    expect(modelLimitFromResponse({ error: { type: "usage_limit_reached", resets_at: -1 } }, 429, "invalid", now)?.retryAt).toBe(now + 18_000_000);
    expect(modelLimitFromResponse({}, 429, new Date(now + 120_000).toUTCString(), now)?.retryAt).toBe(now + 120_000);
    expect(modelLimitFromResponse({}, 429, "999999999", now)?.retryAt).toBe(now + 7 * 86_400_000);
    expect(modelLimitFromResponse({ error: { code: "server_error" } }, 500, null, now)).toBeUndefined();
    expect(modelLimitFromResponse({}, 401, null, now)).toBeUndefined();
  });
  it("observes usage before a later streamed quota failure and counts each response once", () => {
    const usage = vi.fn();
    const limit = vi.fn();
    const observer = new ModelResponseObserver(usage, limit, 200, null);
    const completed = `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 20 } } })}\r\n\r\n`;
    const failed = `data: ${JSON.stringify({ type: "response.failed", response: { error: { code: "usage_limit_reached", resets_in_seconds: 100 } } })}\n\n`;
    const buffer = Buffer.from(completed + completed + failed);
    for (let index = 0; index < buffer.length; index += 3) observer.push(buffer.subarray(index, index + 3));
    observer.finish();
    expect(usage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 100, cachedInputTokens: 40, outputTokens: 20 });
    expect(limit).toHaveBeenCalledWith(expect.any(ModelUsageLimitError));
  });
  it("discards huge content events, accounts for failed responses and ignores malformed usage", () => {
    const usage = vi.fn();
    const observer = new ModelResponseObserver(usage, vi.fn(), 200, null);
    observer.push(Buffer.from(`data: ${"x".repeat(100_000)}\n`));
    observer.push(Buffer.from('data: {"type":"response.completed","response":{"usage":{"input_tokens":-1,"output_tokens":2}}}\n'));
    observer.push(Buffer.from('data: {"type":"response.failed","response":{"usage":{"input_tokens":10,"output_tokens":3}}}\n'));
    observer.finish();
    expect(usage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 10, cachedInputTokens: 0, outputTokens: 3 });
  });
  it("detects direct CLI usage-limit events without retaining error text", () => {
    const collector = new UsageCollector();
    collector.push(Buffer.from('{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":5,"output_tokens":3}}\n'));
    collector.push(Buffer.from('{"type":"turn.failed","error":{"message":"You\u0027ve hit your usage limit. private content"}}\n'));
    expect(collector.totals()).toEqual({ inputTokens: 10, cachedInputTokens: 5, outputTokens: 3 });
    expect(collector.limit()).toBeInstanceOf(ModelUsageLimitError);
    expect(collector.limit()?.message).not.toContain("private content");
  });
  it("defers wrapped failures and stops reconciled/restarted jobs before analysis", async () => {
    const operation = vi.fn().mockRejectedValue(new AnalysisAttemptError("attempt", new ModelUsageLimitError(now + 18_000_000)));
    const store = { remainingMs: vi.fn().mockResolvedValue(0), defer: vi.fn().mockResolvedValue(18_000_000) };
    const rateLimit = vi.fn().mockResolvedValue(undefined);
    const onBlocked = vi.fn().mockResolvedValue(undefined);
    const options = { store, rateLimit, onBlocked };
    await expect(runWithModelCooldown(operation, options)).rejects.toThrow("bullmq:rateLimitExceeded");
    expect(store.defer).toHaveBeenCalledWith(now + 18_000_000);
    expect(rateLimit).toHaveBeenCalledWith(18_000_000);
    expect(onBlocked).toHaveBeenCalledWith(18_000_000, true);
    operation.mockClear();
    store.remainingMs.mockResolvedValue(17_000_000);
    await expect(runWithModelCooldown(operation, options)).rejects.toThrow("bullmq:rateLimitExceeded");
    expect(operation).not.toHaveBeenCalled();
    expect(store.defer).toHaveBeenCalledTimes(1);
    expect(onBlocked).toHaveBeenLastCalledWith(17_000_000, false);
    store.remainingMs.mockResolvedValue(0);
    operation.mockResolvedValue("handed-off");
    await expect(runWithModelCooldown(operation, options)).resolves.toBe("handed-off");
  });
  it("leaves ordinary failures unchanged and fails closed when cooldown storage is unavailable", async () => {
    const error = new Error("ordinary failure");
    const operation = vi.fn().mockRejectedValue(error);
    const options = { store: { remainingMs: vi.fn().mockResolvedValue(0), defer: vi.fn() }, rateLimit: vi.fn(), onBlocked: vi.fn() };
    await expect(runWithModelCooldown(operation, options)).rejects.toBe(error);
    options.store.remainingMs.mockRejectedValue(new Error("Redis unavailable"));
    operation.mockClear();
    await expect(runWithModelCooldown(operation, options)).rejects.toThrow("Redis unavailable");
    expect(operation).not.toHaveBeenCalled();
    expect(options.rateLimit).not.toHaveBeenCalled();
  });
  it("reads durable cooldown state across store recreation and refuses missing expiry", async () => {
    const redis = { pttl: vi.fn().mockResolvedValue(18_000_000), eval: vi.fn().mockResolvedValue(18_000_000) };
    const first = new ModelCooldownStore(redis, "reviews");
    await expect(first.defer(Date.now() + 18_000_000)).resolves.toBe(18_000_000);
    await expect(new ModelCooldownStore(redis, "reviews").remainingMs()).resolves.toBe(18_000_000);
    expect(redis.pttl.mock.calls[0]![0]).toBe(redis.eval.mock.calls[0]![2]);
    redis.pttl.mockResolvedValue(-1);
    await expect(first.remainingMs()).rejects.toThrow("expiry");
    redis.pttl.mockResolvedValue(-2);
    await expect(first.remainingMs()).resolves.toBe(0);
  });
});

describe("review resource ceilings", () => {
  it("defaults to one thread, validates overrides and includes them in shared policy identity", () => {
    expect(loadReviewAgentThreads({})).toBe(1);
    expect(loadReviewAgentThreads({ CODEX_AGENT_THREADS: "3" })).toBe(3);
    for (const value of ["0", "4", "1.5", "junk"])
      expect(() => loadReviewAgentThreads({ CODEX_AGENT_THREADS: value })).toThrow("CODEX_AGENT_THREADS");
    expect(reviewPolicyHash({ CODEX_AGENT_THREADS: "1" })).not.toBe(reviewPolicyHash({ CODEX_AGENT_THREADS: "3" }));
  });
  it("never raises a low effort or configured thread cap, including high-risk reviews", () => {
    expect(reviewResourcePolicy("low", 1, true)).toEqual({ reasoningEffort: "low", agentThreads: 1 });
    expect(reviewResourcePolicy("high", 3, true)).toEqual({ reasoningEffort: "medium", agentThreads: 1 });
    expect(reviewResourcePolicy("medium", 1, false)).toEqual({ reasoningEffort: "medium", agentThreads: 1 });
    expect(reviewResourcePolicy("high", 2, false)).toEqual({ reasoningEffort: "high", agentThreads: 2 });
  });
});
