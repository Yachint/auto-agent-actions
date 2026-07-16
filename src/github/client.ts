const API_VERSION = "2026-03-10";
const FULL_GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export interface GitHubPullRequestState {
  readonly state: "open" | "closed";
  readonly draft: boolean;
  readonly headSha: string;
  readonly headRepository: string;
}

export interface GitHubPullRequestDetails extends GitHubPullRequestState {
  readonly baseSha: string;
  readonly baseBranch: string;
  readonly baseRepository: string;
  readonly cloneUrl: string;
}

export interface GitHubReviewComment {
  readonly path: string;
  readonly body: string;
  readonly line: number;
  readonly side: "RIGHT";
  readonly start_line?: number;
  readonly start_side?: "RIGHT";
}

export interface CreateGitHubReviewInput {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly commitId: string;
  readonly body: string;
  readonly event: "COMMENT";
  readonly comments: readonly GitHubReviewComment[];
}

export interface GitHubReviewClient {
  getPullRequest(
    repository: string,
    pullRequestNumber: number,
  ): Promise<GitHubPullRequestState>;
  createReview(input: CreateGitHubReviewInput): Promise<{ reviewId: number }>;
}

export interface GitHubRepositoryClient {
  getPullRequestDetails(
    repository: string,
    pullRequestNumber: number,
  ): Promise<GitHubPullRequestDetails>;
}

export interface GitHubOpenPullRequest {
  readonly pullRequestNumber: number;
  readonly draft: boolean;
  readonly headSha: string;
  readonly headRepository: string;
}

export interface GitHubPullRequestListClient {
  listOpenPullRequests(repository: string): Promise<readonly GitHubOpenPullRequest[]>;
}

export interface GitHubRestClientOptions {
  readonly installationToken: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly apiBaseUrl?: string;
  readonly timeoutMs?: number;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export class GitHubRestClient
  implements GitHubReviewClient, GitHubRepositoryClient, GitHubPullRequestListClient
{
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #apiBaseUrl: string;
  readonly #timeoutMs: number;

  constructor(options: GitHubRestClientOptions) {
    if (options.installationToken.length === 0) {
      throw new TypeError("installationToken must not be empty");
    }
    const apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
    const parsedBaseUrl = new URL(apiBaseUrl);
    if (parsedBaseUrl.protocol !== "https:" && parsedBaseUrl.hostname !== "127.0.0.1") {
      throw new TypeError("apiBaseUrl must use HTTPS");
    }
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new TypeError("timeoutMs must be a positive integer");
    }

    this.#token = options.installationToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#apiBaseUrl = apiBaseUrl.replace(/\/$/, "");
    this.#timeoutMs = timeoutMs;
  }

  async getPullRequest(
    repository: string,
    pullRequestNumber: number,
  ): Promise<GitHubPullRequestState> {
    const path = pullRequestPath(repository, pullRequestNumber);
    const value = await this.#request(path, { method: "GET" });
    return parsePullRequestState(value);
  }

  async getPullRequestDetails(
    repository: string,
    pullRequestNumber: number,
  ): Promise<GitHubPullRequestDetails> {
    const path = pullRequestPath(repository, pullRequestNumber);
    const value = await this.#request(path, { method: "GET" });
    const payload = requireRecord(value, "pull request response");
    const state = parsePullRequestState(payload);
    const base = requireRecord(payload.base, "base");
    const baseRepository = requireRecord(base.repo, "base.repo");
    const baseSha = requireSha(base.sha, "base.sha");
    return {
      ...state,
      baseSha,
      baseBranch: requireString(base.ref, "base.ref"),
      baseRepository: requireString(baseRepository.full_name, "base.repo.full_name"),
      cloneUrl: requireString(baseRepository.clone_url, "base.repo.clone_url"),
    };
  }

  async listOpenPullRequests(repository: string): Promise<readonly GitHubOpenPullRequest[]> {
    const repositoryPath = repositoryApiPath(repository);
    const results: GitHubOpenPullRequest[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const value = await this.#request(
        `${repositoryPath}/pulls?state=open&per_page=100&page=${page}`,
        { method: "GET" },
      );
      if (!Array.isArray(value)) {
        throw new GitHubApiError("GitHub returned an invalid pull request list");
      }
      for (const item of value) {
        const payload = requireRecord(item, "pull request list item");
        const state = parsePullRequestState(payload);
        results.push({
          pullRequestNumber: requirePositiveInteger(payload.number, "number"),
          draft: state.draft,
          headSha: state.headSha,
          headRepository: state.headRepository,
        });
      }
      if (value.length < 100) return Object.freeze(results);
    }
    throw new GitHubApiError("GitHub pull request list exceeded the page limit");
  }

  async createReview(input: CreateGitHubReviewInput): Promise<{ reviewId: number }> {
    validateFullSha(input.commitId, "commitId");
    const path = `${pullRequestPath(input.repository, input.pullRequestNumber)}/reviews`;
    const value = await this.#request(path, {
      method: "POST",
      body: JSON.stringify({
        commit_id: input.commitId,
        body: input.body,
        event: input.event,
        comments: input.comments,
      }),
    });
    const payload = requireRecord(value, "review response");
    return { reviewId: requirePositiveInteger(payload.id, "id") };
  }

  async #request(path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#apiBaseUrl}${path}`, {
        ...init,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.#token}`,
          "Content-Type": "application/json",
          "User-Agent": "auto-agent-actions",
          "X-GitHub-Api-Version": API_VERSION,
        },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new GitHubApiError("GitHub API request failed");
    }

    if (!response.ok) {
      throw new GitHubApiError(`GitHub API returned HTTP ${response.status}`, response.status);
    }
    try {
      return await response.json();
    } catch {
      throw new GitHubApiError("GitHub API returned invalid JSON", response.status);
    }
  }
}

function parsePullRequestState(value: unknown): GitHubPullRequestState {
  const payload = requireRecord(value, "pull request response");
  const state = requireString(payload.state, "state");
  if (state !== "open" && state !== "closed") {
    throw new GitHubApiError("GitHub returned an invalid pull request state");
  }
  if (typeof payload.draft !== "boolean") {
    throw new GitHubApiError("GitHub returned an invalid pull request draft state");
  }
  const head = requireRecord(payload.head, "head");
  const headRepository = requireRecord(head.repo, "head.repo");
  return {
    state,
    draft: payload.draft,
    headSha: requireSha(head.sha, "head.sha"),
    headRepository: requireString(headRepository.full_name, "head.repo.full_name"),
  };
}

function requireSha(value: unknown, name: string): string {
  const sha = requireString(value, name).toLowerCase();
  if (!FULL_GIT_SHA_PATTERN.test(sha)) {
    throw new GitHubApiError(`GitHub returned an invalid ${name}`);
  }
  return sha;
}

function pullRequestPath(repository: string, pullRequestNumber: number): string {
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
    throw new TypeError("pullRequestNumber must be a positive integer");
  }
  return `${repositoryApiPath(repository)}/pulls/${pullRequestNumber}`;
}

function repositoryApiPath(repository: string): string {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new TypeError("repository must have owner/name format");
  }
  return `/repos/${encodeURIComponent(parts[0]!)}/${encodeURIComponent(parts[1]!)}`;
}

function validateFullSha(value: string, name: string): void {
  if (!FULL_GIT_SHA_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a full Git object ID`);
  }
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GitHubApiError(`GitHub returned an invalid ${name}`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new GitHubApiError(`GitHub returned an invalid ${name}`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new GitHubApiError(`GitHub returned an invalid ${name}`);
  }
  return value;
}
