import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL_BUDGET, ModelBudgetExceededError, ReviewModelBudget } from "../../src/codex/model-budget.js";
import { createModelProxy } from "../../src/codex/model-proxy.js";
import { loadModelBudgetLimits } from "../../src/config/runtime.js";
import { reviewPolicyHash } from "../../src/queue/policy.js";
import { isTerminalInspectionFailure } from "../../src/workflows/analysis-failure.js";

const model = "gpt-6.1-sol";
const response = (input = 4, cached = 2, output = 2) => new Response(`data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: input, input_tokens_details: { cached_tokens: cached }, output_tokens: output } } })}\n\n`);
const request = async (proxy: Awaited<ReturnType<typeof createModelProxy>>, input: unknown = []) => {
  const r = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", headers: { Authorization: `Bearer ${proxy.token}` }, body: JSON.stringify({ model, input }) });
  await r.text(); return r.status;
};
const setup = (budget: ReviewModelBudget, fetchUpstream = vi.fn<typeof fetch>().mockImplementation(async () => response()), onRequest = vi.fn()) => createModelProxy({ model, budget, fetch: fetchUpstream, onRequest, upstreamUrl: "https://chatgpt.com/backend-api/codex/responses", authorization: "Bearer private-credential", timeoutMs: 10000 });

describe("parent-owned model budget", () => {
  it("rejects excessive repeated context before forwarding it upstream", async () => {
    const budget = new ReviewModelBudget({ ...DEFAULT_MODEL_BUDGET, maxRequestBytes: 1024 });
    const upstream = vi.fn<typeof fetch>(); const proxy = await setup(budget, upstream);
    try {
      await request(proxy, "private context".repeat(1000)).catch(() => {});
      expect(upstream).not.toHaveBeenCalled();
      expect(budget.failure()?.reason).toBe("request-size");
      expect(proxy.signal.aborted).toBe(true);
      expect(JSON.stringify(budget.failure())).not.toContain("private context");
    } finally { await proxy.close(); }
  });
  it("stops the next request at the invocation ceiling and marks it terminal", async () => {
    const budget = new ReviewModelBudget({ ...DEFAULT_MODEL_BUDGET, maxRequestsPerInvocation: 2 });
    const upstream = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const proxy = await setup(budget, upstream);
    try {
      await request(proxy); await request(proxy); await request(proxy); await request(proxy);
      expect(upstream).toHaveBeenCalledTimes(2);
      expect(budget.failure()).toMatchObject({ reason: "invocation-request-count" });
      expect(isTerminalInspectionFailure(budget.failure())).toBe(true);
      expect(proxy.signal.aborted).toBe(true);
    } finally { await proxy.close(); }
  });
  it("shares the attempt ceiling across new proxies, including final verification", async () => {
    const budget = new ReviewModelBudget({ ...DEFAULT_MODEL_BUDGET, maxRequests: 3 });
    const upstream = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const first = await setup(budget, upstream);
    await request(first); await request(first); await first.close();
    const second = await setup(budget, upstream);
    try {
      await request(second); await request(second);
      expect(upstream).toHaveBeenCalledTimes(3);
      expect(budget.failure()).toMatchObject({ reason: "request-count", totals: { requests: 3, inputTokens: 12, cachedInputTokens: 6, outputTokens: 6 } });
    } finally { await second.close(); }
  });
  it.each(["input", "output"])("checks observed %s token ceilings before another request", async (which) => {
    const budget = new ReviewModelBudget({ ...DEFAULT_MODEL_BUDGET, ...(which === "input" ? { maxInputTokens: 4 } : { maxOutputTokens: 2 }) });
    const upstream = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const proxy = await setup(budget, upstream);
    try {
      await request(proxy); await request(proxy);
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(budget.failure()?.reason).toBe(which === "input" ? "input-tokens" : "output-tokens");
    } finally { await proxy.close(); }
  });
  it("stops immediately when a completed response reports a token overrun", async () => {
    const budget = new ReviewModelBudget({ ...DEFAULT_MODEL_BUDGET, maxInputTokens: 3 });
    const proxy = await setup(budget);
    try {
      await request(proxy).catch(() => {});
      expect(budget.failure()?.reason).toBe("input-tokens");
      expect(proxy.signal.aborted).toBe(true);
      expect(budget.totals().inputTokens).toBe(4);
    } finally { await proxy.close(); }
  });
  it.each(["missing", "malformed", "oversized"])("fails closed when response usage is %s", async (kind) => {
    const body = kind === "oversized" ? `data: ${"private".repeat(10000)}\n` : kind === "malformed"
      ? 'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"input_tokens_details":{"cached_tokens":2},"output_tokens":1}}}\n' : 'data: done\n';
    const budget = new ReviewModelBudget();
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const diagnostics = vi.fn(); const proxy = await setup(budget, upstream, diagnostics);
    try {
      await request(proxy).catch(() => {}); await request(proxy).catch(() => {});
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(budget.failure()?.reason).toBe("unobserved-usage");
      expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ usageObserved: false }));
      expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("private");
    } finally { await proxy.close(); }
  });
  it("serializes concurrent admission until previous usage is known", async () => {
    const budget = new ReviewModelBudget({ ...DEFAULT_MODEL_BUDGET, maxInputTokens: 4 });
    let complete!: (response: Response) => void;
    const upstream = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>((resolve) => { complete = resolve; }));
    const proxy = await setup(budget, upstream);
    try {
      const a = request(proxy); await vi.waitUntil(() => upstream.mock.calls.length === 1);
      const b = request(proxy); complete(response());
      await Promise.all([a,b]);
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(budget.failure()?.reason).toBe("input-tokens");
    } finally { await proxy.close(); }
  });
  it("logs bounded numeric request/usage diagnostics without private content", async () => {
    const diagnostics = vi.fn(); const budget = new ReviewModelBudget(); const proxy = await setup(budget, undefined, diagnostics);
    try {
      await request(proxy, [{ type: "function_call_output", output: "Process exited with code 0\nprivate source" }]);
      expect(diagnostics).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ request: 1, inputTokens: 4, cachedInputTokens: 2, outputTokens: 2, status: 200, usageObserved: true, inputItems: 1, toolOutputBytes: expect.any(Number) }));
      expect(proxy.diagnostics()).toMatchObject({ upstreamRequests: 1, inputTokens: 4, cachedInputTokens: 2, outputTokens: 2, totalRequestBytes: expect.any(Number) });
      expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("private");
      expect(JSON.stringify(proxy.diagnostics())).not.toContain("private");
    } finally { await proxy.close(); }
  });
  it("supports bounded ordinary JSON Responses usage as well as SSE", async () => {
    const budget = new ReviewModelBudget();
    const proxy = await setup(budget, vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ object: "response", usage: { input_tokens: 10, output_tokens: 3 } }))));
    try { await request(proxy); expect(budget.totals()).toMatchObject({ inputTokens: 10, cachedInputTokens: 0, outputTokens: 3 }); expect(budget.failure()).toBeUndefined(); }
    finally { await proxy.close(); }
  });
  it("preserves quota cooldown and credential-renewal precedence when usage is absent", async () => {
    for (const status of [401,429]) {
      const budget = new ReviewModelBudget(); const proxy = await setup(budget, vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status })));
      try { await request(proxy); expect(budget.failure()).toBeUndefined(); expect(status === 429 ? proxy.usageLimit() : proxy.authenticationFailed()).toBeTruthy(); }
      finally { await proxy.close(); }
    }
  });
  it("includes validated operator limits in scheduling identity", () => {
    expect(loadModelBudgetLimits({})).toEqual(DEFAULT_MODEL_BUDGET);
    for (const key of ["REVIEW_MAX_MODEL_REQUESTS", "REVIEW_MAX_GROUP_REQUESTS", "REVIEW_MAX_REQUEST_BYTES", "REVIEW_MAX_INPUT_TOKENS", "REVIEW_MAX_OUTPUT_TOKENS"])
      for (const value of ["0", "-1", "1.5", "invalid", "999999999"])
        expect(() => loadModelBudgetLimits({ [key]: value })).toThrow(key);
    expect(reviewPolicyHash({})).not.toBe(reviewPolicyHash({ REVIEW_MAX_MODEL_REQUESTS: "12" }));
    expect(isTerminalInspectionFailure(new Error("ordinary"))).toBe(false);
    expect(new ModelBudgetExceededError("request-count", { requests: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }).message).not.toContain("private");
  });
});
