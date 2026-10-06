import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable, Transform } from "node:stream";
import type { CodexUsage } from "./usage.js";
import { modelLimitFromResponse, type ModelUsageLimitError } from "./model-limit.js";
import { ModelResponseObserver } from "./model-response.js";

export interface ModelProxyDiagnostics {
  requests: number;
  maxRequestBytes: number;
  toolOutputs: number;
  successfulCommands: number;
  failedCommands: number;
  dispatchErrors: number;
  unsupportedCalls: number;
}

export class ModelProxyPolicyError extends Error {
  diagnostics?: ModelProxyDiagnostics;
  constructor(readonly reason: "request-size" | "request-count" | "expired") {
    super("review model proxy policy prevented further requests");
    this.name = "ModelProxyPolicyError";
  }
}

export interface ModelProxyOptions {
  readonly model: string;
  readonly upstreamUrl: string;
  readonly authorization: string;
  readonly accountId?: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly onUsage?: (usage: CodexUsage) => void;
}

/** Per-job, loopback-only capability. No GitHub, OAuth-refresh or generic URL forwarding. */
export async function createModelProxy(options: ModelProxyOptions) {
  const url = new URL(options.upstreamUrl);
  if (
    url.protocol !== "https:" ||
    !["api.openai.com", "chatgpt.com"].includes(url.hostname)
  )
    throw new TypeError("model upstream is not allowlisted");
  const token = randomBytes(32).toString("hex");
  const expires = Date.now() + options.timeoutMs;
  let requests = 0;
  let authenticationFailed = false;
  let usageLimit: ModelUsageLimitError | undefined;
  let policyFailure: ModelProxyPolicyError | undefined;
  const diagnostics: ModelProxyDiagnostics = {
    requests: 0, maxRequestBytes: 0, toolOutputs: 0,
    successfulCommands: 0, failedCommands: 0, dispatchErrors: 0, unsupportedCalls: 0,
  };
  const limited = new AbortController();
  const denyPolicy = (reason: ModelProxyPolicyError["reason"]) => {
    policyFailure ??= new ModelProxyPolicyError(reason);
    policyFailure.diagnostics = { ...diagnostics };
    limited.abort();
  };
  const observeLimit = (error: ModelUsageLimitError) => {
    if (!usageLimit || error.retryAt > usageLimit.retryAt) usageLimit = error;
    limited.abort();
  };
  const active = new Set<AbortController>();
  const server = createServer(async (request, response) => {
    const provided = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    ) {
      response.writeHead(401).end();
      return;
    }
    if (usageLimit) {
      response.writeHead(429, {
        "Retry-After": String(Math.max(1,
          Math.ceil((usageLimit.retryAt - Date.now()) / 1000))),
      }).end();
      return;
    }
    if (policyFailure || request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(403).end();
      return;
    }
    if (Date.now() >= expires || ++requests > 200) {
      diagnostics.requests = requests;
      denyPolicy(Date.now() >= expires ? "expired" : "request-count");
      response.writeHead(403).end();
      return;
    }
    diagnostics.requests = requests;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk);
        diagnostics.maxRequestBytes = Math.max(diagnostics.maxRequestBytes, size);
        if (size > 2 * 1024 * 1024) {
          denyPolicy("request-size");
          response.writeHead(413).end();
          request.destroy();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      const payload = JSON.parse(body.toString("utf8")) as Record<
        string,
        unknown
      >;
      if (payload.model !== options.model) {
        response.writeHead(403).end();
        return;
      }
      // Only fixed numeric metadata survives; no commands, paths or tool output.
      if (Array.isArray(payload.input)) {
        const advertised = new Set(
          Array.isArray(payload.tools)
            ? payload.tools.slice(0, 1000).filter((tool) => typeof tool === "object" && tool !== null).map((tool) => tool.name)
            : [],
        );
        let outputs = 0, successful = 0, failed = 0, dispatch = 0, unsupported = 0;
        for (const item of payload.input.slice(0, 1000)) {
          if (typeof item !== "object" || item === null) continue;
          if (item.type === "function_call" &&
            !advertised.has(item.name))
            unsupported++;
          if (item.type !== "function_call_output" || typeof item.output !== "string") continue;
          outputs++;
          if (/Process exited with code 0\b/.test(item.output)) successful++;
          if (/Process exited with code [1-9][0-9]*\b/.test(item.output)) failed++;
          if (/unknown tool|unrecognized (?:tool|function)|error parsing function call|invalid function call/i.test(item.output)) dispatch++;
        }
        diagnostics.toolOutputs = Math.max(diagnostics.toolOutputs, outputs);
        diagnostics.successfulCommands = Math.max(diagnostics.successfulCommands, successful);
        diagnostics.failedCommands = Math.max(diagnostics.failedCommands, failed);
        diagnostics.dispatchErrors = Math.max(diagnostics.dispatchErrors, dispatch);
        diagnostics.unsupportedCalls = Math.max(diagnostics.unsupportedCalls, unsupported);
      }
      const controller = new AbortController();
      active.add(controller);
      response.once("close", () => {
        controller.abort();
        active.delete(controller);
      });
      const upstream = await (options.fetch ?? globalThis.fetch)(url, {
        method: "POST",
        body,
        headers: {
          Authorization: options.authorization,
          "Content-Type": "application/json",
          ...(options.accountId === undefined
            ? {}
            : { "ChatGPT-Account-Id": options.accountId }),
        },
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(
            Math.min(300_000, Math.max(1, expires - Date.now())),
          ),
        ]),
      });
      if (upstream.status === 401 || upstream.status === 403)
        authenticationFailed = true;
      const retryAfter = upstream.headers.get("retry-after");
      const observer = new ModelResponseObserver(
        options.onUsage, observeLimit, upstream.status, retryAfter,
      );
      response.writeHead(upstream.status, {
        "Content-Type":
          upstream.headers.get("content-type") ?? "application/json",
      });
      if (upstream.body !== null) {
        const observed = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            observer.push(chunk);
            callback(null, chunk);
          },
          flush(callback) {
            observer.finish();
            // A malformed/empty 429 is still a backoff signal.
            if (upstream.status === 429 && !usageLimit)
              observeLimit(modelLimitFromResponse(undefined, 429, retryAfter)!);
            callback();
          },
        });
        Readable.fromWeb(
          upstream.body as import("node:stream/web").ReadableStream,
        )
          .on("error", () => response.destroy())
          .pipe(observed)
          .on("error", () => response.destroy())
          .pipe(response);
      } else {
        if (upstream.status === 429)
          observeLimit(modelLimitFromResponse(undefined, 429, retryAfter)!);
        response.end();
      }
    } catch {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("model proxy did not bind");
  return {
    authenticationFailed: () => authenticationFailed,
    usageLimit: () => usageLimit,
    policyFailure: () => policyFailure,
    diagnostics: (): ModelProxyDiagnostics => ({ ...diagnostics }),
    signal: limited.signal,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    token,
    close: async () => {
      for (const controller of active) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export class ModelAuthenticationError extends Error {
  constructor() {
    super("model credentials require operator renewal");
    this.name = "ModelAuthenticationError";
  }
}
