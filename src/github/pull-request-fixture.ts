const SUPPORTED_ACTIONS = new Set([
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
]);
const FULL_GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export interface PullRequestFixture {
  action: "opened" | "reopened" | "synchronize" | "ready_for_review";
  repository: string;
  remoteUrl: string;
  pullRequestNumber: number;
  baseBranch: string;
  baseSha: string;
  headSha: string;
}

export class FixtureValidationError extends Error {
  constructor(message: string) {
    super(`Invalid pull request fixture: ${message}`);
    this.name = "FixtureValidationError";
  }
}

export class ReviewNotEligibleError extends Error {
  constructor(reason: string) {
    super(`Pull request is not eligible for review: ${reason}`);
    this.name = "ReviewNotEligibleError";
  }
}

export function parsePullRequestFixture(value: unknown): PullRequestFixture {
  const payload = requireRecord(value, "payload");
  const action = requireString(payload.action, "action");
  if (!SUPPORTED_ACTIONS.has(action)) {
    throw new ReviewNotEligibleError(`unsupported action ${JSON.stringify(action)}`);
  }

  const pullRequestNumber = requirePositiveInteger(payload.number, "number");
  const repository = requireRecord(payload.repository, "repository");
  const pullRequest = requireRecord(payload.pull_request, "pull_request");
  const base = requireRecord(pullRequest.base, "pull_request.base");
  const head = requireRecord(pullRequest.head, "pull_request.head");
  const baseRepository = requireRecord(base.repo, "pull_request.base.repo");
  const headRepository = requireRecord(head.repo, "pull_request.head.repo");

  if (pullRequest.state !== "open") {
    throw new ReviewNotEligibleError("pull request is not open");
  }
  if (pullRequest.draft === true) {
    throw new ReviewNotEligibleError("pull request is a draft");
  }
  if (pullRequest.draft !== false) {
    throw new FixtureValidationError("pull_request.draft must be a boolean");
  }

  const repositoryName = requireString(repository.full_name, "repository.full_name");
  const baseRepositoryName = requireString(
    baseRepository.full_name,
    "pull_request.base.repo.full_name",
  );
  const headRepositoryName = requireString(
    headRepository.full_name,
    "pull_request.head.repo.full_name",
  );
  if (baseRepositoryName !== repositoryName) {
    throw new FixtureValidationError(
      "pull_request.base.repo.full_name must match repository.full_name",
    );
  }
  if (headRepositoryName !== repositoryName) {
    throw new ReviewNotEligibleError("forked pull requests are not supported");
  }
  const remoteUrl = requireString(repository.clone_url, "repository.clone_url");
  const baseBranch = requireString(base.ref, "pull_request.base.ref");
  const baseSha = requireFullSha(base.sha, "pull_request.base.sha");
  const headSha = requireFullSha(head.sha, "pull_request.head.sha");

  if (baseSha === headSha) {
    throw new FixtureValidationError("base and head SHAs must be different");
  }

  return {
    action: action as PullRequestFixture["action"],
    repository: repositoryName,
    remoteUrl,
    pullRequestNumber,
    baseBranch,
    baseSha,
    headSha,
  };
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FixtureValidationError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new FixtureValidationError(`${name} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new FixtureValidationError(`${name} must be a positive integer`);
  }
  return value;
}

function requireFullSha(value: unknown, name: string): string {
  const sha = requireString(value, name).toLowerCase();
  if (!FULL_GIT_SHA_PATTERN.test(sha)) {
    throw new FixtureValidationError(`${name} must be a full Git object ID`);
  }
  return sha;
}
