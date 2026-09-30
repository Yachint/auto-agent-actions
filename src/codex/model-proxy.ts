import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";

export interface ModelProxyOptions {
  readonly model: string;
  readonly upstreamUrl: string;
  readonly authorization: string;
  readonly accountId?: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof globalThis.fetch;
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
    if (
      request.method !== "POST" ||
      request.url !== "/v1/responses" ||
      Date.now() >= expires ||
      ++requests > 200
    ) {
      response.writeHead(403).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk);
        if (size > 2 * 1024 * 1024) {
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
      response.writeHead(upstream.status, {
        "Content-Type":
          upstream.headers.get("content-type") ?? "application/json",
      });
      if (upstream.body !== null)
        Readable.fromWeb(
          upstream.body as import("node:stream/web").ReadableStream,
        )
          .on("error", () => response.destroy())
          .pipe(response);
      else response.end();
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
