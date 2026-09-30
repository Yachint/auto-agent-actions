import { createPrivateKey, sign } from "node:crypto";

import { GitHubApiError, githubResponseError } from "./client.js";

const API_VERSION = "2026-03-10";
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1_000;

export interface GitHubAppIdentity {
  readonly appId: number;
  readonly botLogin: string;
}
export interface GitHubAppIdentityProvider {
  getAppIdentity(): Promise<GitHubAppIdentity>;
}

export interface InstallationToken {
  readonly token: string;
  readonly expiresAt: Date;
}

export interface InstallationTokenProvider {
  getToken(
    installationId: number,
    repository: string,
    purpose: InstallationTokenPurpose,
  ): Promise<InstallationToken>;
}

export interface RepositoryInstallationProvider {
  getRepositoryInstallationId(repository: string): Promise<number>;
}

export type InstallationTokenPurpose = "repository-read" | "review-write";

export interface GitHubAppAuthOptions {
  readonly appId: string;
  readonly privateKey: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly apiBaseUrl?: string;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  readonly enableChecks?: boolean;
}

export class GitHubAppAuth
  implements
    InstallationTokenProvider,
    RepositoryInstallationProvider,
    GitHubAppIdentityProvider
{
  #identity: { value: GitHubAppIdentity; expiresAt: number } | undefined;
  readonly #enableChecks: boolean;
  readonly #appId: string;
  readonly #privateKey: ReturnType<typeof createPrivateKey>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #apiBaseUrl: string;
  readonly #timeoutMs: number;
  readonly #now: () => Date;
  readonly #cache = new Map<string, InstallationToken>();
  readonly #installations = new Map<
    string,
    { id: number; expiresAt: number }
  >();

  constructor(options: GitHubAppAuthOptions) {
    if (!/^\d+$/.test(options.appId) || options.appId === "0") {
      throw new TypeError("appId must be a positive integer string");
    }
    try {
      this.#privateKey = createPrivateKey(options.privateKey);
    } catch {
      throw new TypeError("privateKey must be a valid private key");
    }
    if (this.#privateKey.asymmetricKeyType !== "rsa") {
      throw new TypeError("privateKey must be an RSA private key");
    }
    const apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
    const parsedBaseUrl = new URL(apiBaseUrl);
    if (
      parsedBaseUrl.protocol !== "https:" &&
      parsedBaseUrl.hostname !== "127.0.0.1"
    ) {
      throw new TypeError("apiBaseUrl must use HTTPS");
    }
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new TypeError("timeoutMs must be a positive integer");
    }
    this.#enableChecks = options.enableChecks ?? false;
    this.#appId = options.appId;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#apiBaseUrl = apiBaseUrl.replace(/\/$/, "");
    this.#timeoutMs = timeoutMs;
    this.#now = options.now ?? (() => new Date());
  }

  async getAppIdentity(): Promise<GitHubAppIdentity> {
    if (this.#identity && this.#identity.expiresAt > this.#now().getTime())
      return this.#identity.value;
    let response: Response;
    try {
      response = await this.#fetch(`${this.#apiBaseUrl}/app`, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${createAppJwt(this.#appId, this.#privateKey, this.#now())}`,
          "User-Agent": "auto-agent-actions",
          "X-GitHub-Api-Version": API_VERSION,
        },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new GitHubApiError("GitHub App identity request failed");
    }
    if (!response.ok)
      throw githubResponseError(response, "GitHub App identity endpoint");
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new GitHubApiError("GitHub App identity returned invalid JSON");
    }
    const app = requireRecord(value);
    if (
      app.id !== Number(this.#appId) ||
      !Number.isSafeInteger(app.id) ||
      typeof app.slug !== "string" ||
      !/^[a-zA-Z0-9-]{1,100}$/.test(app.slug)
    )
      throw new GitHubApiError(
        "GitHub App identity does not match configuration",
      );
    const identity = Object.freeze({
      appId: app.id as number,
      botLogin: `${app.slug}[bot]`,
    });
    this.#identity = {
      value: identity,
      expiresAt: this.#now().getTime() + 300_000,
    };
    return identity;
  }

  async getToken(
    installationId: number,
    repository: string,
    purpose: InstallationTokenPurpose,
  ): Promise<InstallationToken> {
    if (!Number.isSafeInteger(installationId) || installationId < 1) {
      throw new TypeError("installationId must be a positive integer");
    }
    const repositoryName = parseRepositoryName(repository);
    const cacheKey = `${installationId}:${repository.toLowerCase()}:${purpose}`;
    const cached = this.#cache.get(cacheKey);
    if (
      cached !== undefined &&
      cached.expiresAt.getTime() - this.#now().getTime() >
        TOKEN_REFRESH_MARGIN_MS
    ) {
      return cached;
    }

    if ((await this.getRepositoryInstallationId(repository)) !== installationId)
      throw new GitHubApiError(
        "repository installation does not match request",
        403,
      );
    const jwt = createAppJwt(this.#appId, this.#privateKey, this.#now());
    let response: Response;
    try {
      response = await this.#fetch(
        `${this.#apiBaseUrl}/app/installations/${installationId}/access_tokens`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${jwt}`,
            "Content-Type": "application/json",
            "User-Agent": "auto-agent-actions",
            "X-GitHub-Api-Version": API_VERSION,
          },
          body: JSON.stringify({
            repositories: [repositoryName],
            permissions:
              purpose === "repository-read"
                ? { contents: "read", pull_requests: "read" }
                : {
                    pull_requests: "write",
                    ...(this.#enableChecks ? { checks: "write" } : {}),
                  },
          }),
          signal: AbortSignal.timeout(this.#timeoutMs),
        },
      );
    } catch {
      throw new GitHubApiError("GitHub installation token request failed");
    }
    if (!response.ok) {
      throw githubResponseError(response, "GitHub installation token endpoint");
    }

    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new GitHubApiError(
        "GitHub installation token endpoint returned invalid JSON",
        response.status,
      );
    }
    const payload = requireRecord(value);
    const token = requireString(payload.token, "token");
    const expiresAtValue = requireString(payload.expires_at, "expires_at");
    const expiresAt = new Date(expiresAtValue);
    if (
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt.getTime() <= this.#now().getTime()
    ) {
      throw new GitHubApiError(
        "GitHub returned an invalid installation token expiry",
      );
    }
    const result = Object.freeze({ token, expiresAt });
    this.#cache.set(cacheKey, result);
    return result;
  }

  async getRepositoryInstallationId(repository: string): Promise<number> {
    const [owner, name] = parseRepository(repository);
    const cached = this.#installations.get(repository.toLowerCase());
    if (cached !== undefined && cached.expiresAt > this.#now().getTime())
      return cached.id;
    const jwt = createAppJwt(this.#appId, this.#privateKey, this.#now());
    let response: Response;
    try {
      response = await this.#fetch(
        `${this.#apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
        {
          method: "GET",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${jwt}`,
            "User-Agent": "auto-agent-actions",
            "X-GitHub-Api-Version": API_VERSION,
          },
          signal: AbortSignal.timeout(this.#timeoutMs),
        },
      );
    } catch {
      throw new GitHubApiError("GitHub repository installation request failed");
    }
    if (!response.ok) {
      throw githubResponseError(
        response,
        "GitHub repository installation endpoint",
      );
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new GitHubApiError(
        "GitHub repository installation endpoint returned invalid JSON",
      );
    }
    const id = requireRecord(value).id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
      throw new GitHubApiError(
        "GitHub returned an invalid repository installation id",
      );
    }
    this.#installations.set(repository.toLowerCase(), {
      id,
      expiresAt: this.#now().getTime() + 300_000,
    });
    return id;
  }
}

export function createAppJwt(
  appId: string,
  privateKey: ReturnType<typeof createPrivateKey>,
  now: Date,
): string {
  const issuedAt = Math.floor(now.getTime() / 1_000) - 60;
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({ iat: issuedAt, exp: issuedAt + 9 * 60, iss: appId }),
  );
  const unsigned = `${header}.${payload}`;
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(unsigned),
    privateKey,
  ).toString("base64url");
  return `${unsigned}.${signature}`;
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function parseRepositoryName(repository: string): string {
  return parseRepository(repository)[1];
}

function parseRepository(repository: string): [string, string] {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new TypeError("repository must have owner/name format");
  }
  return [parts[0]!, parts[1]!];
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GitHubApiError(
      "GitHub returned an invalid installation token response",
    );
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new GitHubApiError(`GitHub returned an invalid installation ${name}`);
  }
  return value;
}
