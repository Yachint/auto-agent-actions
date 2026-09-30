import type { GitHubAppIdentity } from "./app-auth.js";
import type { ExactDiff } from "../repositories/diff.js";
import { githubChangedFile } from "./diff.js";
const API_VERSION = "2026-03-10";
const FULL_GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export interface GitHubPullRequestState {
  readonly state: "open" | "closed";
  readonly draft: boolean;
  readonly headSha: string;
  readonly headRepository: string;
  readonly baseSha?: string;
  readonly baseBranch?: string;
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
  readonly event: "COMMENT" | "REQUEST_CHANGES";
  readonly comments: readonly GitHubReviewComment[];
}

export interface CheckStatus {
  readonly status: "queued" | "in_progress" | "completed";
  readonly conclusion?: "success" | "failure" | "neutral" | "action_required";
}
export interface GitHubReviewClient {
  getReviewCommand?(
    repository: string,
    number: number,
    commentId: number,
  ): Promise<{
    body: string;
    login: string;
    userType: string;
    createdAt: string;
  }>;
  canRequestReview?(repository: string, login: string): Promise<boolean>;
  unresolvedFindingThreads?(
    repository: string,
    number: number,
  ): Promise<ReadonlyMap<string, string>>;
  dismissReview?(
    repository: string,
    number: number,
    reviewId: number,
  ): Promise<void>;
  setCheckStatus?(
    repository: string,
    headSha: string,
    scopeSha: string,
    status: CheckStatus,
  ): Promise<void>;
  getPullRequest(
    repository: string,
    pullRequestNumber: number,
  ): Promise<GitHubPullRequestState>;
  getReviewDiff?(
    repository: string,
    number: number,
    baseSha: string,
    headSha: string,
  ): Promise<ExactDiff>;
  findReview?(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    marker: string,
  ): Promise<{ reviewId: number; state?: string } | null>;
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
  readonly baseBranch?: string;
  readonly baseSha?: string;
}

export interface GitHubPullRequestListClient {
  listOpenPullRequests(
    repository: string,
  ): Promise<readonly GitHubOpenPullRequest[]>;
}

export interface GitHubRestClientOptions {
  readonly appIdentity?: GitHubAppIdentity;
  readonly installationToken: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly apiBaseUrl?: string;
  readonly timeoutMs?: number;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export class GitHubRestClient
  implements
    GitHubReviewClient,
    GitHubRepositoryClient,
    GitHubPullRequestListClient
{
  readonly #appIdentity: GitHubAppIdentity | undefined;
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

    this.#appIdentity = options.appIdentity;
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
      baseRepository: requireString(
        baseRepository.full_name,
        "base.repo.full_name",
      ),
      cloneUrl: requireString(baseRepository.clone_url, "base.repo.clone_url"),
    };
  }

  async listOpenPullRequests(
    repository: string,
  ): Promise<readonly GitHubOpenPullRequest[]> {
    const repositoryPath = repositoryApiPath(repository);
    const results: GitHubOpenPullRequest[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const value = await this.#request(
        `${repositoryPath}/pulls?state=open&per_page=100&page=${page}`,
        { method: "GET" },
      );
      if (!Array.isArray(value)) {
        throw new GitHubApiError(
          "GitHub returned an invalid pull request list",
        );
      }
      for (const item of value) {
        const payload = requireRecord(item, "pull request list item");
        const state = parsePullRequestState(payload);
        results.push({
          pullRequestNumber: requirePositiveInteger(payload.number, "number"),
          draft: state.draft,
          headSha: state.headSha,
          headRepository: state.headRepository,
          ...(state.baseSha === undefined ? {} : { baseSha: state.baseSha }),
          ...(state.baseBranch === undefined
            ? {}
            : { baseBranch: state.baseBranch }),
        });
      }
      if (value.length < 100) return Object.freeze(results);
    }
    throw new GitHubApiError(
      "GitHub pull request list exceeded the page limit",
    );
  }

  async getReviewCommand(
    repository: string,
    number: number,
    commentId: number,
  ) {
    requirePositiveInteger(commentId, "commentId");
    const comment = requireRecord(
      await this.#request(
        `${repositoryApiPath(repository)}/issues/comments/${commentId}`,
        { method: "GET" },
      ),
      "command comment",
    );
    const issue = new URL(requireString(comment.issue_url, "issue_url"));
    if (
      issue.hostname !== new URL(this.#apiBaseUrl).hostname ||
      issue.pathname !== `${repositoryApiPath(repository)}/issues/${number}`
    )
      throw new GitHubApiError(
        "comment does not belong to the requested pull request",
      );
    const user = requireRecord(comment.user, "comment user");
    return {
      body: requireString(comment.body, "comment body"),
      login: requireString(user.login, "login"),
      userType: requireString(user.type, "user type"),
      createdAt: requireString(comment.created_at, "created_at"),
    };
  }

  async canRequestReview(repository: string, login: string): Promise<boolean> {
    if (!/^[a-zA-Z0-9-]{1,39}$/.test(login)) return false;
    const result = requireRecord(
      await this.#request(
        `${repositoryApiPath(repository)}/collaborators/${encodeURIComponent(login)}/permission`,
        { method: "GET" },
      ),
      "collaborator permission",
    );
    return ["admin", "maintain", "write"].includes(
      requireString(result.permission, "permission"),
    );
  }

  async unresolvedFindingThreads(
    repository: string,
    number: number,
  ): Promise<ReadonlyMap<string, string>> {
    const author = this.#requireAppIdentity().botLogin;
    const [owner, name] = repository.split("/");
    const results = new Map<string, string>();
    let after: string | null = null;
    const query =
      "query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){nodes{isResolved comments(first:1){nodes{body url author{login __typename}}}}pageInfo{hasNextPage endCursor}}}}}";
    for (let page = 0; page < 5; page++) {
      const response = requireRecord(
        await this.#request("/graphql", {
          method: "POST",
          body: JSON.stringify({
            query,
            variables: { owner, name, number, after },
          }),
        }),
        "threads",
      );
      if (response.errors !== undefined)
        throw new GitHubApiError("GitHub thread query failed");
      const data = requireRecord(response.data, "thread data");
      const repo = requireRecord(data.repository, "thread repository");
      const pull = requireRecord(repo.pullRequest, "thread pull request");
      const threads = requireRecord(pull.reviewThreads, "review threads");
      if (!Array.isArray(threads.nodes) || threads.nodes.length > 100)
        throw new GitHubApiError("invalid review threads");
      for (const item of threads.nodes) {
        const thread = requireRecord(item, "thread");
        if (typeof thread.isResolved !== "boolean")
          throw new GitHubApiError("invalid thread disposition");
        if (thread.isResolved) continue;
        const comments = requireRecord(thread.comments, "thread comments");
        if (!Array.isArray(comments.nodes) || comments.nodes.length !== 1)
          continue;
        const comment = requireRecord(comments.nodes[0], "thread comment");
        const actor = requireRecord(comment.author, "thread author");
        if (
          actor.login !== author ||
          actor.__typename !== "Bot" ||
          typeof comment.body !== "string" ||
          typeof comment.url !== "string"
        )
          continue;
        const marker = [
          ...comment.body.matchAll(
            /<!-- auto-agent-actions:finding=([0-9a-f]{64}) -->/g,
          ),
        ].at(-1)?.[1];
        if (marker === undefined) continue;
        const url = new URL(comment.url);
        if (
          url.protocol !== "https:" ||
          url.hostname !== "github.com" ||
          url.pathname !== `/${repository}/pull/${number}` ||
          !/^#discussion_r[0-9]+$/.test(url.hash)
        )
          throw new GitHubApiError("invalid finding thread URL");
        results.set(marker, url.toString());
      }
      const info = requireRecord(threads.pageInfo, "thread page");
      if (info.hasNextPage === false) return results;
      after = requireString(info.endCursor, "thread cursor");
    }
    throw new GitHubApiError("review threads exceeded page limit");
  }

  async dismissReview(
    repository: string,
    number: number,
    reviewId: number,
  ): Promise<void> {
    requirePositiveInteger(reviewId, "reviewId");
    await this.#request(
      `${pullRequestPath(repository, number)}/reviews/${reviewId}/dismissals`,
      {
        method: "PUT",
        body: JSON.stringify({
          message:
            "This automated review was superseded by a newer pull request comparison.",
          event: "DISMISS",
        }),
      },
    );
  }

  async setCheckStatus(
    repository: string,
    headSha: string,
    scopeSha: string,
    status: CheckStatus,
  ): Promise<void> {
    validateFullSha(headSha, "headSha");
    const appId = this.#requireAppIdentity().appId;
    const name = "Auto Agent Actions";
    const externalId = `auto-agent-actions:${scopeSha}`;
    const list = requireRecord(
      await this.#request(
        `${repositoryApiPath(repository)}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(name)}&per_page=100`,
        { method: "GET" },
      ),
      "checks",
    );
    if (!Array.isArray(list.check_runs) || list.check_runs.length >= 100)
      throw new GitHubApiError("invalid or oversized check list");
    const existing = list.check_runs.find(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        value.external_id === externalId &&
        value.app?.id === appId,
    );
    const id =
      existing === undefined
        ? undefined
        : requirePositiveInteger(existing.id, "id");
    await this.#request(
      `${repositoryApiPath(repository)}/check-runs${id === undefined ? "" : `/${id}`}`,
      {
        method: id === undefined ? "POST" : "PATCH",
        body: JSON.stringify({
          name,
          head_sha: headSha,
          external_id: externalId,
          ...status,
          ...(status.status === "completed"
            ? { completed_at: new Date().toISOString() }
            : {}),
          output: {
            title: "Automated PR review",
            summary:
              status.status === "completed"
                ? "Review processing finished. See the bot review for findings and scope limitations."
                : "Review processing is pending.",
          },
        }),
      },
    );
  }

  async getReviewDiff(
    repository: string,
    number: number,
    baseSha: string,
    headSha: string,
  ): Promise<ExactDiff> {
    const check = async () => {
      const current = await this.getPullRequest(repository, number);
      if (current.headSha !== headSha || current.baseSha !== baseSha)
        throw new GitHubApiError(
          "GitHub diff scope changed during publication",
          409,
        );
    };
    await check();
    const files: ExactDiff["files"] = [];
    for (let page = 1; page <= 6; page++) {
      const values = await this.#request(
        `${pullRequestPath(repository, number)}/files?per_page=100&page=${page}`,
        { method: "GET" },
      );
      if (!Array.isArray(values))
        throw new GitHubApiError("invalid GitHub diff files");
      files.push(...values.map(githubChangedFile));
      if (files.length > 500)
        throw new GitHubApiError("GitHub diff exceeds file limit");
      if (values.length < 100) {
        await check();
        return { baseSha, headSha, files };
      }
    }
    throw new GitHubApiError("GitHub diff exceeds page limit");
  }

  async findReview(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    marker: string,
  ): Promise<{ reviewId: number; state?: string } | null> {
    // Derive the authenticated App identity; never trust a marker written by a human or another bot.
    const identity = this.#requireAppIdentity();
    const author = requireRecord(
      await this.#request(`/users/${encodeURIComponent(identity.botLogin)}`, {
        method: "GET",
      }),
      "App bot",
    );
    if (author.type !== "Bot")
      throw new GitHubApiError("App review author is not a bot");
    const authorId = requirePositiveInteger(author.id, "id");
    for (let page = 1; page <= 100; page++) {
      const values = await this.#request(
        `${pullRequestPath(repository, pullRequestNumber)}/reviews?per_page=100&page=${page}`,
        { method: "GET" },
      );
      if (!Array.isArray(values))
        throw new GitHubApiError("GitHub returned invalid reviews");
      for (const value of values) {
        const review = requireRecord(value, "review");
        const user = review.user;
        if (typeof user !== "object" || user === null || Array.isArray(user))
          continue;
        if (
          (user as Record<string, unknown>).id === authorId &&
          (user as Record<string, unknown>).type === "Bot" &&
          review.commit_id === headSha &&
          typeof review.body === "string" &&
          review.body.trimEnd().endsWith(marker) &&
          review.state !== "PENDING"
        ) {
          if (
            ![
              "APPROVED",
              "CHANGES_REQUESTED",
              "COMMENTED",
              "DISMISSED",
            ].includes(String(review.state))
          )
            throw new GitHubApiError("GitHub returned invalid review state");
          return {
            reviewId: requirePositiveInteger(review.id, "id"),
            ...(typeof review.state === "string"
              ? { state: review.state }
              : {}),
          };
        }
      }
      if (values.length < 100) return null;
    }
    throw new GitHubApiError("GitHub review list exceeded the page limit");
  }

  async createReview(
    input: CreateGitHubReviewInput,
  ): Promise<{ reviewId: number }> {
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

  #requireAppIdentity(): GitHubAppIdentity {
    if (
      !this.#appIdentity ||
      !Number.isSafeInteger(this.#appIdentity.appId) ||
      this.#appIdentity.appId < 1 ||
      !/^[a-zA-Z0-9-]{1,100}\[bot\]$/.test(this.#appIdentity.botLogin)
    )
      throw new TypeError(
        "trusted GitHub App identity is required for publication",
      );
    return this.#appIdentity;
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
      throw githubResponseError(response, "GitHub API");
    }
    try {
      return await response.json();
    } catch {
      throw new GitHubApiError(
        "GitHub API returned invalid JSON",
        response.status,
      );
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
    throw new GitHubApiError(
      "GitHub returned an invalid pull request draft state",
    );
  }
  const head = requireRecord(payload.head, "head");
  const base =
    payload.base === undefined
      ? undefined
      : requireRecord(payload.base, "base");
  const headRepository = requireRecord(head.repo, "head.repo");
  return {
    state,
    ...(base === undefined
      ? {}
      : {
          baseSha: requireSha(base.sha, "base.sha"),
          baseBranch: requireString(base.ref, "base.ref"),
        }),
    draft: payload.draft,
    headSha: requireSha(head.sha, "head.sha"),
    headRepository: requireString(
      headRepository.full_name,
      "head.repo.full_name",
    ),
  };
}

function requireSha(value: unknown, name: string): string {
  const sha = requireString(value, name).toLowerCase();
  if (!FULL_GIT_SHA_PATTERN.test(sha)) {
    throw new GitHubApiError(`GitHub returned an invalid ${name}`);
  }
  return sha;
}

function pullRequestPath(
  repository: string,
  pullRequestNumber: number,
): string {
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

export function githubResponseError(
  response: Response,
  label: string,
): GitHubApiError {
  const rawRetry = response.headers.get("retry-after");
  const seconds = rawRetry === null ? NaN : Number(rawRetry);
  const retry = Number.isFinite(seconds)
    ? seconds * 1000
    : rawRetry === null
      ? 0
      : Date.parse(rawRetry) - Date.now();
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  const rateLimited =
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        rawRetry !== null));
  const delay = rateLimited
    ? Math.min(
        86_400_000,
        Math.max(
          60_000,
          Number.isFinite(retry) ? retry : 0,
          response.headers.get("x-ratelimit-remaining") === "0" &&
            Number.isFinite(reset)
            ? reset * 1000 - Date.now()
            : 0,
        ),
      )
    : undefined;
  return new GitHubApiError(
    `${label} returned HTTP ${response.status}`,
    response.status,
    delay,
  );
}
