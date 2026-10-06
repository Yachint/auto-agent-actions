import { expect, it, vi } from "vitest";
import { createModelProxy, ModelProxyPolicyError } from "../../src/codex/model-proxy.js";

it("does not forward a request beyond the proxy's request-count ceiling", async () => {
  const fetchUpstream = vi.fn<typeof fetch>().mockImplementation(async()=>new Response(null));
  const proxy = await createModelProxy({ model:"gpt-6.1-sol",authorization:"Bearer secret",upstreamUrl:"https://api.openai.com/v1/responses",timeoutMs:10000,fetch:fetchUpstream });
  try {
    for(let i=0;i<201;i++) await (await fetch(`${proxy.baseUrl}/responses`,{method:"POST",headers:{Authorization:`Bearer ${proxy.token}`},body:JSON.stringify({model:"gpt-6.1-sol"})})).text();
    expect(fetchUpstream).toHaveBeenCalledTimes(200);
    expect(proxy.policyFailure()?.reason).toBe("request-count");
    expect(proxy.signal.aborted).toBe(true);
  } finally { await proxy.close(); }
});

it("fails closed when the job's model capability expires", async () => {
  const fetchUpstream=vi.fn<typeof fetch>();
  const proxy=await createModelProxy({model:"gpt-6.1-sol",authorization:"Bearer secret",upstreamUrl:"https://api.openai.com/v1/responses",timeoutMs:10000,fetch:fetchUpstream});
  const now=Date.now();const clock=vi.spyOn(Date,"now").mockReturnValue(now+20000);
  try {
    expect((await fetch(`${proxy.baseUrl}/responses`,{method:"POST",headers:{Authorization:`Bearer ${proxy.token}`},body:JSON.stringify({model:"gpt-6.1-sol"})})).status).toBe(403);
    expect(fetchUpstream).not.toHaveBeenCalled();
    expect(proxy.policyFailure()?.reason).toBe("expired");
  } finally { clock.mockRestore();await proxy.close(); }
});

it("stops oversize requests before upstream spending and retains safe policy diagnostics", async () => {
  const fetchUpstream = vi.fn<typeof fetch>();
  const proxy = await createModelProxy({ model: "gpt-6.1-sol", authorization: "Bearer secret", upstreamUrl: "https://api.openai.com/v1/responses", timeoutMs: 10_000, fetch: fetchUpstream });
  const request = (body: string) => fetch(`${proxy.baseUrl}/responses`, { method: "POST", headers: { Authorization: `Bearer ${proxy.token}` }, body });
  try {
    await request(JSON.stringify({model:"gpt-6.1-sol", input:"private text "+"x".repeat(2*1024*1024)})).catch(() => {});
    expect(proxy.policyFailure()).toBeInstanceOf(ModelProxyPolicyError);
    expect(proxy.policyFailure()?.reason).toBe("request-size");
    expect(proxy.signal.aborted).toBe(true);
    expect((await request(JSON.stringify({model:"gpt-6.1-sol"}))).status).toBe(403);
    expect(fetchUpstream).not.toHaveBeenCalled();
    expect(JSON.stringify(proxy.policyFailure())).not.toContain("private text");
  } finally { await proxy.close(); }
});

it("counts tool success and dispatch failures without retaining tool output or commands", async () => {
  const proxy = await createModelProxy({ model: "gpt-6.1-sol", authorization: "Bearer secret", upstreamUrl: "https://api.openai.com/v1/responses", timeoutMs: 10_000, fetch: vi.fn<typeof fetch>().mockImplementation(async()=>new Response('data: done\n')) });
  try {
    await (await fetch(`${proxy.baseUrl}/responses`, {method:"POST",headers:{Authorization:`Bearer ${proxy.token}`},body:JSON.stringify({model:"gpt-6.1-sol",tools:[{type:"function",name:"exec_command"}],input:[
      {type:"function_call",name:"exec_command",arguments:"private command"},
      {type:"function_call",name:"private_tool_name"},
      {type:"function_call_output",output:"Process exited with code 0\nprivate source"},
      {type:"function_call_output",output:"Process exited with code 128\nprivate error"},
      {type:"function_call_output",output:"unknown tool private_tool_name"},
    ]})})).text();
    expect(proxy.diagnostics()).toMatchObject({requests:1,toolOutputs:3,successfulCommands:1,failedCommands:1,dispatchErrors:1,unsupportedCalls:1});
    expect(JSON.stringify(proxy.diagnostics())).not.toContain("private");
  } finally { await proxy.close(); }
});
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
