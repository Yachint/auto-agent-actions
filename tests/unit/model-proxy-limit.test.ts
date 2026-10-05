import { expect, it, vi } from "vitest";
import { createModelProxy } from "../../src/codex/model-proxy.js";
import { ModelUsageLimitError } from "../../src/codex/model-limit.js";

it.each([false, true])("records model usage on failed reviews and blocks subsequent upstream requests (SSE quota=%s)", async (streamed) => {
  const retryAt = Math.floor(Date.now() / 1000) + 3600;
  const completed = `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 50 }, output_tokens: 20 } } })}\n\n`;
  const error = { code: "usage_limit_reached", resets_at: retryAt, message: "private upstream diagnostic" };
  const body = streamed ? `data: ${JSON.stringify({ type: "response.failed", response: { error } })}\n\n` : JSON.stringify({ error });
  const fetchUpstream = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(completed, { headers: { "content-type": "text/event-stream" } }))
    .mockResolvedValueOnce(new Response(body, { status: streamed ? 200 : 429 }));
  const usage = vi.fn();
  const proxy = await createModelProxy({ model: "gpt-6.1-sol", authorization: "Bearer upstream-secret", upstreamUrl: "https://chatgpt.com/backend-api/codex/responses", timeoutMs: 10_000, fetch: fetchUpstream, onUsage: usage });
  const request = () => fetch(`${proxy.baseUrl}/responses`, { method: "POST", headers: { Authorization: `Bearer ${proxy.token}` }, body: JSON.stringify({ model: "gpt-6.1-sol" }) });
  try {
    expect(await (await request()).text()).toBe(completed);
    expect(await (await request()).text()).toBe(body);
    expect(usage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 100, cachedInputTokens: 50, outputTokens: 20 });
    expect(proxy.usageLimit()).toBeInstanceOf(ModelUsageLimitError);
    expect(proxy.usageLimit()?.retryAt).toBe(retryAt * 1000);
    expect(proxy.signal.aborted).toBe(true);
    expect(JSON.stringify(proxy.usageLimit())).not.toContain("private upstream diagnostic");
    expect(proxy.authenticationFailed()).toBe(false);
    expect((await request()).status).toBe(429);
    expect(fetchUpstream).toHaveBeenCalledTimes(2);
  } finally {
    await proxy.close();
  }
});

it.each(["", "unstructured throttle error"]) ("backs off an empty or malformed HTTP 429 using Retry-After (%s)", async (body) => {
  const proxy = await createModelProxy({ model: "gpt-6.1-sol", authorization: "Bearer secret", upstreamUrl: "https://api.openai.com/v1/responses", timeoutMs: 10_000, fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 429, headers: { "retry-after": "120" } })) });
  try {
    const started = Date.now();
    const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", headers: { Authorization: `Bearer ${proxy.token}` }, body: JSON.stringify({ model: "gpt-6.1-sol" }) });
    await response.text();
    expect(proxy.usageLimit()?.retryAt).toBeGreaterThanOrEqual(started + 120_000);
    expect(proxy.signal.aborted).toBe(true);
  } finally {
    await proxy.close();
  }
});
