import { createHmac, timingSafeEqual } from "node:crypto";

import type { DeliveryClaims, ReviewQueue, ReviewRequest } from "../queue/review-queue.js";

const SUPPORTED_ACTIONS = new Set<PullRequestAction>([
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
]);
const FULL_GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/i;

export type PullRequestAction =
  | "opened"
  | "reopened"
  | "synchronize"
  | "ready_for_review";

export interface GitHubWebhookHeaders {
  readonly signature: string;
  readonly event: string;
  readonly deliveryId: string;
}

export interface WebhookDependencies {
  readonly secret: string;
  readonly allowedRepositories: ReadonlySet<string>;
  readonly queue: ReviewQueue;
  readonly deliveryClaims: DeliveryClaims;
}

export class WebhookRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "WebhookRequestError";
  }
}

export async function acceptGitHubWebhook(
  rawBody: Buffer,
  headers: GitHubWebhookHeaders,
  dependencies: WebhookDependencies,
): Promise<{ enqueued: boolean }> {
  if (!verifyGitHubSignature(rawBody, headers.signature, dependencies.secret)) {
    throw new WebhookRequestError("invalid webhook signature", 401);
  }
  if (headers.event !== "pull_request") {
    throw new WebhookRequestError("unsupported GitHub event", 400);
  }
  if (headers.deliveryId.trim().length === 0) {
    throw new WebhookRequestError("missing GitHub delivery ID", 400);
  }

  const request = parseReviewRequest(rawBody, headers.deliveryId);
  if (!dependencies.allowedRepositories.has(request.repository)) {
    throw new WebhookRequestError("repository is not allowlisted", 403);
  }

  const claimed = await dependencies.deliveryClaims.claim(headers.deliveryId);
  if (!claimed) {
    return { enqueued: false };
  }

  try {
    await dependencies.queue.enqueue(request);
  } catch (error) {
    await dependencies.deliveryClaims.release(headers.deliveryId);
    throw error;
  }
  return { enqueued: true };
}

export function verifyGitHubSignature(
  rawBody: Buffer,
  suppliedSignature: string,
  secret: string,
): boolean {
  const match = SIGNATURE_PATTERN.exec(suppliedSignature);
  if (match === null || secret.length === 0) {
    return false;
  }
  const suppliedDigest = Buffer.from(match[1]!, "hex");
  const expectedDigest = createHmac("sha256", secret).update(rawBody).digest();
  return (
    suppliedDigest.length === expectedDigest.length &&
    timingSafeEqual(suppliedDigest, expectedDigest)
  );
}

function parseReviewRequest(rawBody: Buffer, deliveryId: string): ReviewRequest {
  let value: unknown;
  try {
    value = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new WebhookRequestError("webhook body must be valid JSON", 400);
  }

  const payload = requireRecord(value, "payload");
  const action = requireString(payload.action, "action");
  if (!SUPPORTED_ACTIONS.has(action as PullRequestAction)) {
    throw new WebhookRequestError("unsupported pull request action", 422);
  }

  const repository = requireRecord(payload.repository, "repository");
  const repositoryName = requireString(repository.full_name, "repository.full_name");
  const installation = requireRecord(payload.installation, "installation");
  const pullRequest = requireRecord(payload.pull_request, "pull_request");
  const base = requireRecord(pullRequest.base, "pull_request.base");
  const head = requireRecord(pullRequest.head, "pull_request.head");
  const baseRepository = requireRecord(base.repo, "pull_request.base.repo");
  const headRepository = requireRecord(head.repo, "pull_request.head.repo");

  if (pullRequest.state !== "open") {
    throw new WebhookRequestError("pull request is not open", 422);
  }
  if (pullRequest.draft !== false) {
    throw new WebhookRequestError("pull request is a draft or has invalid draft state", 422);
  }
  if (requireString(baseRepository.full_name, "pull_request.base.repo.full_name") !== repositoryName) {
    throw new WebhookRequestError("pull request base repository does not match repository", 400);
  }
  if (requireString(headRepository.full_name, "pull_request.head.repo.full_name") !== repositoryName) {
    throw new WebhookRequestError("forked pull requests are not supported", 422);
  }

  const headSha = requireString(head.sha, "pull_request.head.sha").toLowerCase();
  if (!FULL_GIT_SHA_PATTERN.test(headSha)) {
    throw new WebhookRequestError("pull_request.head.sha must be a full Git object ID", 400);
  }

  return Object.freeze({
    deliveryId,
    installationId: requirePositiveInteger(installation.id, "installation.id"),
    repository: repositoryName,
    pullRequestNumber: requirePositiveInteger(payload.number, "number"),
    action: action as PullRequestAction,
    headSha,
  });
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WebhookRequestError(`${name} must be an object`, 400);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new WebhookRequestError(`${name} must be a non-empty string`, 400);
  }
  return value;
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new WebhookRequestError(`${name} must be a positive integer`, 400);
  }
  return value;
}
