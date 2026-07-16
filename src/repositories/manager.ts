import { lstat, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  assertAbsolutePath,
  createGitExecutor,
  decodeGitText,
  type GitExecutor,
} from "./git.js";

const REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const FULL_GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export interface RepositoryManagerOptions {
  dataDirectory: string;
  gitExecutor?: GitExecutor;
}

export interface FetchReviewRefsInput {
  repository: string;
  remoteUrl: string;
  baseBranch: string;
  pullRequestNumber: number;
  expectedBaseSha: string;
  expectedHeadSha: string;
  authentication?: GitHubFetchAuthentication;
}

export interface GitHubFetchAuthentication {
  readonly installationToken: string;
}

export interface FetchedReviewRefs {
  mirrorPath: string;
  baseSha: string;
  headSha: string;
}

export interface ReviewWorktree {
  path: string;
  headSha: string;
  dispose(): Promise<void>;
}

export class StaleReviewRefError extends Error {
  constructor(refName: "base" | "head") {
    super(`Fetched ${refName} ref no longer matches the expected SHA`);
    this.name = "StaleReviewRefError";
  }
}

export class RepositoryManager {
  readonly dataDirectory: string;
  readonly gitExecutor: GitExecutor;

  constructor(options: RepositoryManagerOptions) {
    assertAbsolutePath("dataDirectory", options.dataDirectory);
    this.dataDirectory = path.resolve(options.dataDirectory);
    this.gitExecutor = options.gitExecutor ?? createGitExecutor();
  }

  async fetchReviewRefs(
    input: FetchReviewRefsInput,
  ): Promise<FetchedReviewRefs> {
    validateFetchInput(input);
    const mirrorPath = await this.ensureMirror(input.repository);
    const namespace = `refs/auto-agent-actions/pulls/${input.pullRequestNumber}`;
    const baseRef = `${namespace}/base`;
    const headRef = `${namespace}/head`;

    await this.withFetchAuthentication(input, async (authentication) => {
      await this.gitExecutor({
        args: [
          `--git-dir=${mirrorPath}`,
          "fetch",
          "--force",
          "--no-tags",
          "--no-write-fetch-head",
          "--",
          input.remoteUrl,
          `+refs/heads/${input.baseBranch}:${baseRef}`,
          `+refs/pull/${input.pullRequestNumber}/head:${headRef}`,
        ],
        timeoutMs: 120_000,
        ...(authentication === undefined ? {} : { authentication }),
      });
    });

    const [baseSha, headSha] = await Promise.all([
      this.resolveCommit(mirrorPath, baseRef),
      this.resolveCommit(mirrorPath, headRef),
    ]);

    if (baseSha !== input.expectedBaseSha.toLowerCase()) {
      throw new StaleReviewRefError("base");
    }
    if (headSha !== input.expectedHeadSha.toLowerCase()) {
      throw new StaleReviewRefError("head");
    }

    return { mirrorPath, baseSha, headSha };
  }

  async createWorktree(input: {
    repository: string;
    pullRequestNumber: number;
    mirrorPath: string;
    headSha: string;
  }): Promise<ReviewWorktree> {
    validateRepository(input.repository);
    validatePullRequestNumber(input.pullRequestNumber);
    validateFullSha("headSha", input.headSha);
    assertAbsolutePath("mirrorPath", input.mirrorPath);

    const expectedMirror = await realpath(this.mirrorPath(input.repository));
    const suppliedMirror = await realpath(input.mirrorPath);
    if (expectedMirror !== suppliedMirror) {
      throw new TypeError("mirrorPath does not match the repository mirror");
    }

    const headSha = input.headSha.toLowerCase();
    const resolvedHead = await this.resolveCommit(suppliedMirror, headSha);
    if (resolvedHead !== headSha) {
      throw new TypeError("headSha does not resolve to the exact requested commit");
    }

    const worktreeParent = path.join(
      this.dataDirectory,
      "worktrees",
      input.repository,
      String(input.pullRequestNumber),
    );
    await mkdir(worktreeParent, { recursive: true, mode: 0o700 });
    const worktreePath = path.join(
      worktreeParent,
      `${headSha.slice(0, 12)}-${randomUUID()}`,
    );

    try {
      await this.gitExecutor({
        args: [
          `--git-dir=${suppliedMirror}`,
          "worktree",
          "add",
          "--detach",
          "--no-guess-remote",
          worktreePath,
          headSha,
        ],
        timeoutMs: 120_000,
      });
    } catch (error) {
      await rm(worktreePath, { recursive: true, force: true });
      throw error;
    }

    const checkedOutHead = decodeGitText(
      await this.gitExecutor({
        args: ["-C", worktreePath, "rev-parse", "--verify", "HEAD^{commit}"],
      }),
    ).trim();

    if (checkedOutHead !== headSha) {
      await this.removeWorktree(suppliedMirror, worktreePath);
      throw new TypeError("worktree HEAD does not match the requested commit");
    }

    let disposed = false;
    return {
      path: worktreePath,
      headSha,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await this.removeWorktree(suppliedMirror, worktreePath);
      },
    };
  }

  async withWorktree<T>(
    input: Parameters<RepositoryManager["createWorktree"]>[0],
    operation: (worktree: ReviewWorktree) => Promise<T>,
  ): Promise<T> {
    const worktree = await this.createWorktree(input);
    try {
      return await operation(worktree);
    } finally {
      await worktree.dispose();
    }
  }

  async cleanupAbandonedWorktrees(
    repositories: ReadonlySet<string>,
    olderThanMs: number,
    now: Date = new Date(),
  ): Promise<number> {
    if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 1) {
      throw new TypeError("olderThanMs must be a positive integer");
    }
    if (!Number.isFinite(now.getTime())) throw new TypeError("now must be a valid date");
    let removed = 0;
    for (const repository of repositories) {
      validateRepository(repository);
      const repositoryRoot = path.join(this.dataDirectory, "worktrees", repository);
      const mirrorPath = this.mirrorPath(repository);
      try {
        if (!(await stat(repositoryRoot)).isDirectory() || !(await stat(mirrorPath)).isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }
      const resolvedDataDirectory = await realpath(this.dataDirectory);
      const resolvedRepositoryRoot = await realpath(repositoryRoot);
      const resolvedMirrorPath = await realpath(mirrorPath);
      if (
        !isPathInside(resolvedDataDirectory, resolvedRepositoryRoot) ||
        !isPathInside(resolvedDataDirectory, resolvedMirrorPath)
      ) {
        throw new TypeError("cleanup path escaped the data directory");
      }
      for (const pullRequestEntry of await readdir(resolvedRepositoryRoot, {
        withFileTypes: true,
      })) {
        if (!pullRequestEntry.isDirectory() || !/^\d+$/.test(pullRequestEntry.name)) continue;
        const pullRequestRoot = path.join(resolvedRepositoryRoot, pullRequestEntry.name);
        for (const worktreeEntry of await readdir(pullRequestRoot, { withFileTypes: true })) {
          if (
            !worktreeEntry.isDirectory() ||
            !/^[0-9a-f]{12}-[0-9a-f-]{36}$/i.test(worktreeEntry.name)
          ) {
            continue;
          }
          const worktreePath = path.join(pullRequestRoot, worktreeEntry.name);
          const metadata = await lstat(worktreePath);
          if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue;
          if (now.getTime() - metadata.mtimeMs < olderThanMs) continue;
          const resolvedWorktreePath = await realpath(worktreePath);
          if (!isPathInside(resolvedRepositoryRoot, resolvedWorktreePath)) {
            throw new TypeError("cleanup worktree escaped the repository directory");
          }
          try {
            await this.removeWorktree(resolvedMirrorPath, resolvedWorktreePath);
          } catch {
            await rm(resolvedWorktreePath, { recursive: true, force: true });
            await this.gitExecutor({
              args: [
                `--git-dir=${resolvedMirrorPath}`,
                "worktree",
                "prune",
                "--expire=now",
              ],
              timeoutMs: 60_000,
            });
          }
          removed += 1;
        }
      }
    }
    return removed;
  }

  private mirrorPath(repository: string): string {
    return path.join(this.dataDirectory, "mirrors", `${repository}.git`);
  }

  private async ensureMirror(repository: string): Promise<string> {
    validateRepository(repository);
    const mirrorPath = this.mirrorPath(repository);
    await mkdir(path.dirname(mirrorPath), { recursive: true, mode: 0o700 });

    let exists = false;
    try {
      exists = (await stat(mirrorPath)).isDirectory();
    } catch {
      // The mirror will be initialized below.
    }

    if (!exists) {
      await this.gitExecutor({ args: ["init", "--bare", mirrorPath] });
    }

    const resolved = await realpath(mirrorPath);
    const mirrorRoot = await realpath(path.join(this.dataDirectory, "mirrors"));
    if (!isPathInside(mirrorRoot, resolved)) {
      throw new TypeError("repository mirror escaped the data directory");
    }

    return resolved;
  }

  private async resolveCommit(mirrorPath: string, revision: string): Promise<string> {
    return decodeGitText(
      await this.gitExecutor({
        args: [
          `--git-dir=${mirrorPath}`,
          "rev-parse",
          "--verify",
          `${revision}^{commit}`,
        ],
      }),
    )
      .trim()
      .toLowerCase();
  }

  private async removeWorktree(
    mirrorPath: string,
    worktreePath: string,
  ): Promise<void> {
    await this.gitExecutor({
      args: [
        `--git-dir=${mirrorPath}`,
        "worktree",
        "remove",
        "--force",
        worktreePath,
      ],
      timeoutMs: 60_000,
    });
  }

  private async withFetchAuthentication<T>(
    input: FetchReviewRefsInput,
    operation: (
      authentication:
        | { askPassPath: string; username: string; password: string }
        | undefined,
    ) => Promise<T>,
  ): Promise<T> {
    if (input.authentication === undefined) return operation(undefined);
    validateGitHubAuthenticatedRemote(input.repository, input.remoteUrl);
    validateInstallationToken(input.authentication.installationToken);

    const runtimeRoot = path.join(this.dataDirectory, "runtime-auth");
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    const resolvedDataDirectory = await realpath(this.dataDirectory);
    const resolvedRuntimeRoot = await realpath(runtimeRoot);
    if (!isPathInside(resolvedDataDirectory, resolvedRuntimeRoot)) {
      throw new TypeError("runtime authentication directory escaped the data directory");
    }
    const temporaryDirectory = await mkdtemp(path.join(resolvedRuntimeRoot, "git-"));
    const askPassPath = path.join(temporaryDirectory, "askpass.sh");
    await writeFile(
      askPassPath,
      '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" "$AUTO_AGENT_GIT_USERNAME" ;;\n  *Password*) printf "%s\\n" "$AUTO_AGENT_GIT_PASSWORD" ;;\n  *) exit 1 ;;\nesac\n',
      { mode: 0o700, flag: "wx" },
    );

    try {
      return await operation({
        askPassPath,
        username: "x-access-token",
        password: input.authentication.installationToken,
      });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

function validateFetchInput(input: FetchReviewRefsInput): void {
  validateRepository(input.repository);
  validateRemoteUrl(input.remoteUrl);
  validateBranch(input.baseBranch);
  validatePullRequestNumber(input.pullRequestNumber);
  validateFullSha("expectedBaseSha", input.expectedBaseSha);
  validateFullSha("expectedHeadSha", input.expectedHeadSha);
}

function validateInstallationToken(token: string): void {
  if (token.length === 0 || token.includes("\0") || /[\r\n]/.test(token)) {
    throw new TypeError("installationToken must be a non-empty single-line credential");
  }
}

function validateGitHubAuthenticatedRemote(repository: string, remoteUrl: string): void {
  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    throw new TypeError("authenticated fetch requires a GitHub HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port !== "" ||
    url.pathname.toLowerCase() !== `/${repository}.git`.toLowerCase()
  ) {
    throw new TypeError("authenticated fetch URL must exactly match the GitHub repository");
  }
}

function validateRepository(repository: string): void {
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new TypeError("repository must use the owner/name format");
  }
}

function validatePullRequestNumber(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("pullRequestNumber must be a positive integer");
  }
}

function validateFullSha(name: string, value: string): void {
  if (!FULL_GIT_SHA_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a full Git object ID`);
  }
}

function validateBranch(branch: string): void {
  if (
    !branch ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".lock") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    /[\x00-\x20~^:?*[\\]/.test(branch)
  ) {
    throw new TypeError("baseBranch is not a safe Git branch name");
  }
}

function validateRemoteUrl(remoteUrl: string): void {
  if (!remoteUrl || remoteUrl.includes("\0")) {
    throw new TypeError("remoteUrl must be a credential-free Git URL");
  }

  if (path.isAbsolute(remoteUrl)) return;
  if (/\s/.test(remoteUrl)) {
    throw new TypeError("remoteUrl must be a credential-free Git URL");
  }
  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    throw new TypeError("remoteUrl must be an absolute local path or HTTPS URL");
  }

  if (url.protocol !== "https:" || url.password || url.search || url.hash) {
    throw new TypeError("remoteUrl must be a credential-free HTTPS URL");
  }
  if (url.username) {
    throw new TypeError("remoteUrl must not contain embedded credentials");
  }
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}
