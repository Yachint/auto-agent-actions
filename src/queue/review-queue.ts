import { createHash } from "node:crypto";

import type { PullRequestAction } from "../github/webhook.js";

export interface ReviewRequest {
  readonly deliveryId: string;
  readonly installationId: number;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly action: PullRequestAction;
  readonly headSha: string;
}

export interface ReviewQueue {
  enqueue(request: ReviewRequest): Promise<void>;
}

export interface DeliveryClaims {
  claim(deliveryId: string): Promise<boolean>;
  release(deliveryId: string): Promise<void>;
}

export class InMemoryDeliveryClaims implements DeliveryClaims {
  readonly #claimed = new Set<string>();

  async claim(deliveryId: string): Promise<boolean> {
    if (this.#claimed.has(deliveryId)) {
      return false;
    }
    this.#claimed.add(deliveryId);
    return true;
  }

  async release(deliveryId: string): Promise<void> {
    this.#claimed.delete(deliveryId);
  }
}

export function validateQueuedReviewRequest(value: unknown): ReviewRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("review queue payload must be an object");
  }
  const payload = value as Record<string, unknown>;
  const expectedKeys = [
    "action",
    "deliveryId",
    "headSha",
    "installationId",
    "pullRequestNumber",
    "repository",
  ];
  if (Object.keys(payload).sort().join(",") !== expectedKeys.sort().join(",")) {
    throw new TypeError("review queue payload has unexpected properties");
  }
  if (
    typeof payload.deliveryId !== "string" ||
    payload.deliveryId.length === 0 ||
    payload.deliveryId.length > 200 ||
    /[\0\r\n]/.test(payload.deliveryId)
  ) {
    throw new TypeError("review queue deliveryId is invalid");
  }
  if (
    typeof payload.repository !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(
      payload.repository,
    )
  ) {
    throw new TypeError("review queue repository is invalid");
  }
  for (const name of ["installationId", "pullRequestNumber"] as const) {
    if (
      typeof payload[name] !== "number" ||
      !Number.isSafeInteger(payload[name]) ||
      payload[name] < 1
    ) {
      throw new TypeError(`review queue ${name} is invalid`);
    }
  }
  if (
    typeof payload.headSha !== "string" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(payload.headSha)
  ) {
    throw new TypeError("review queue headSha is invalid");
  }
  if (
    typeof payload.action !== "string" ||
    !new Set(["opened", "reopened", "synchronize", "ready_for_review"]).has(
      payload.action,
    )
  ) {
    throw new TypeError("review queue action is invalid");
  }
  return Object.freeze({
    deliveryId: payload.deliveryId,
    installationId: payload.installationId as number,
    repository: payload.repository,
    pullRequestNumber: payload.pullRequestNumber as number,
    action: payload.action as PullRequestAction,
    headSha: payload.headSha.toLowerCase(),
  });
}

export function refreshedReviewRequest(
  request: ReviewRequest,
  headSha: string,
): ReviewRequest {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(headSha)) {
    throw new TypeError("refreshed headSha must be a full Git object ID");
  }
  const normalizedHead = headSha.toLowerCase();
  return Object.freeze({
    ...request,
    deliveryId: `refresh-${createHash("sha256")
      .update(`${request.repository}#${request.pullRequestNumber}#${normalizedHead}`)
      .digest("hex")}`,
    action: "synchronize",
    headSha: normalizedHead,
  });
}
