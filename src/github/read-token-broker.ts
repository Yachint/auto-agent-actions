import { timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import type {
  InstallationToken,
  InstallationTokenProvider,
  InstallationTokenPurpose,
} from "./app-auth.js";

const MAX_REQUEST_BYTES = 16 * 1024;

export interface ReadTokenBrokerServerOptions {
  readonly socketPath: string;
  readonly sharedSecret: string;
  readonly allowedRepositories: ReadonlySet<string>;
  readonly tokenProvider: InstallationTokenProvider;
}

export class ReadTokenBrokerServer {
  readonly #options: ReadTokenBrokerServerOptions;
  readonly #server: http.Server;

  constructor(options: ReadTokenBrokerServerOptions) {
    validateBrokerOptions(options.socketPath, options.sharedSecret);
    this.#options = options;
    this.#server = http.createServer((request, response) => {
      void this.#handle(request, response);
    });
  }

  async listen(): Promise<void> {
    await mkdir(path.dirname(this.#options.socketPath), { recursive: true, mode: 0o700 });
    await removeStaleSocket(this.#options.socketPath);
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(this.#options.socketPath, () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
    await chmod(this.#options.socketPath, 0o600);
  }

  async close(): Promise<void> {
    if (this.#server.listening) {
      await new Promise<void>((resolve, reject) =>
        this.#server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
    try {
      await unlink(this.#options.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async #handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      if (request.method !== "POST" || request.url !== "/tokens/repository-read") {
        sendJson(response, 404, { error: "not found" });
        return;
      }
      const result = await authorizeReadTokenRequest(
        request.headers.authorization,
        await readBoundedBody(request),
        this.#options,
      );
      sendJson(response, result.statusCode, result.body);
    } catch {
      sendJson(response, 400, { error: "invalid token request" });
    }
  }
}

export interface ReadTokenBrokerClientOptions {
  readonly socketPath: string;
  readonly sharedSecret: string;
  readonly timeoutMs?: number;
  readonly request?: BrokerRequester;
}

export type BrokerRequester = (
  socketPath: string,
  sharedSecret: string,
  body: object,
  timeoutMs: number,
) => Promise<{ statusCode: number; body: Buffer }>;

export class ReadTokenBrokerClient implements InstallationTokenProvider {
  readonly #socketPath: string;
  readonly #sharedSecret: string;
  readonly #timeoutMs: number;
  readonly #request: BrokerRequester;

  constructor(options: ReadTokenBrokerClientOptions) {
    validateBrokerOptions(options.socketPath, options.sharedSecret);
    this.#socketPath = options.socketPath;
    this.#sharedSecret = options.sharedSecret;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#request = options.request ?? requestBroker;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new TypeError("timeoutMs must be a positive integer");
    }
  }

  async getToken(
    installationId: number,
    repository: string,
    purpose: InstallationTokenPurpose,
  ): Promise<InstallationToken> {
    if (purpose !== "repository-read") {
      throw new TypeError("read token broker cannot issue write tokens");
    }
    const response = await this.#request(
      this.#socketPath,
      this.#sharedSecret,
      { installation_id: installationId, repository },
      this.#timeoutMs,
    );
    if (response.statusCode !== 200) {
      throw new Error(`read token broker returned HTTP ${response.statusCode}`);
    }
    const payload = parseBrokerResponse(response.body);
    return Object.freeze({ token: payload.token, expiresAt: payload.expiresAt });
  }
}

export async function authorizeReadTokenRequest(
  authorizationHeader: string | undefined,
  body: Buffer,
  options: Pick<
    ReadTokenBrokerServerOptions,
    "sharedSecret" | "allowedRepositories" | "tokenProvider"
  >,
): Promise<{ statusCode: number; body: Record<string, string> }> {
  if (!validAuthorization(authorizationHeader, options.sharedSecret)) {
    return { statusCode: 401, body: { error: "unauthorized" } };
  }
  const payload = parseBrokerRequest(body);
  if (!options.allowedRepositories.has(payload.repository)) {
    return { statusCode: 403, body: { error: "repository is not allowlisted" } };
  }
  const token = await options.tokenProvider.getToken(
    payload.installationId,
    payload.repository,
    "repository-read",
  );
  return {
    statusCode: 200,
    body: { token: token.token, expires_at: token.expiresAt.toISOString() },
  };
}

function requestBroker(
  socketPath: string,
  sharedSecret: string,
  body: object,
  timeoutMs: number,
): Promise<{ statusCode: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const serialized = Buffer.from(JSON.stringify(body));
    const request = http.request(
      {
        socketPath,
        path: "/tokens/repository-read",
        method: "POST",
        headers: {
          Authorization: `Bearer ${sharedSecret}`,
          "Content-Type": "application/json",
          "Content-Length": String(serialized.length),
        },
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_REQUEST_BYTES) response.destroy(new Error("broker response too large"));
          else chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({ statusCode: response.statusCode ?? 500, body: Buffer.concat(chunks) }),
        );
      },
    );
    request.once("error", reject);
    request.once("timeout", () => request.destroy(new Error("read token broker timed out")));
    request.end(serialized);
  });
}

async function readBoundedBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) throw new TypeError("request too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseBrokerRequest(body: Buffer): { installationId: number; repository: string } {
  const value = JSON.parse(body.toString("utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("invalid request");
  }
  const payload = value as Record<string, unknown>;
  if (Object.keys(payload).sort().join(",") !== "installation_id,repository") {
    throw new TypeError("invalid request properties");
  }
  if (
    typeof payload.installation_id !== "number" ||
    !Number.isSafeInteger(payload.installation_id) ||
    payload.installation_id < 1 ||
    typeof payload.repository !== "string"
  ) {
    throw new TypeError("invalid request values");
  }
  return { installationId: payload.installation_id, repository: payload.repository };
}

function parseBrokerResponse(body: Buffer): { token: string; expiresAt: Date } {
  const value = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
  if (
    typeof value.token !== "string" ||
    value.token.length === 0 ||
    typeof value.expires_at !== "string"
  ) {
    throw new Error("read token broker returned invalid data");
  }
  const expiresAt = new Date(value.expires_at);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new Error("read token broker returned invalid expiry");
  }
  return { token: value.token, expiresAt };
}

function validAuthorization(header: string | undefined, secret: string): boolean {
  if (header === undefined || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function validateBrokerOptions(socketPath: string, sharedSecret: string): void {
  if (!socketPath.startsWith("/") || socketPath.includes("\0")) {
    throw new TypeError("socketPath must be absolute");
  }
  if (sharedSecret.length < 32 || /[\0\r\n]/.test(sharedSecret)) {
    throw new TypeError("sharedSecret must be a single-line secret of at least 32 characters");
  }
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    const status = await lstat(socketPath);
    if (!status.isSocket()) throw new TypeError("token broker path exists and is not a socket");
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function sendJson(response: http.ServerResponse, statusCode: number, body: object): void {
  if (response.headersSent) return;
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
