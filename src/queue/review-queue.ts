import { createHash } from "node:crypto";

import type { PullRequestAction } from "../github/webhook.js";

export interface ReviewRequest {
  readonly deliveryId: string;
  readonly installationId: number;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly action: PullRequestAction;
  readonly headSha: string;
  readonly baseBranch?: string;
  readonly baseSha?: string;
  readonly scopeSha?: string;
  readonly rerunNonce?: string;
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
  const optionalKeys = ["baseBranch", "baseSha", "scopeSha", "rerunNonce"];
  if (
    expectedKeys.some((key) => !(key in payload)) ||
    Object.keys(payload).some(
      (key) => !expectedKeys.includes(key) && !optionalKeys.includes(key),
    )
  ) {
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
    !new Set([
      "opened",
      "reopened",
      "synchronize",
      "ready_for_review",
      "edited",
    ]).has(payload.action)
  ) {
    throw new TypeError("review queue action is invalid");
  }
  if (
    payload.baseBranch !== undefined &&
    (typeof payload.baseBranch !== "string" ||
      payload.baseBranch.length === 0 ||
      payload.baseBranch.length > 255 ||
      /[\0\r\n]/.test(payload.baseBranch))
  )
    throw new TypeError("review base branch is invalid");
  if (
    payload.baseSha !== undefined &&
    (typeof payload.baseSha !== "string" ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(payload.baseSha))
  )
    throw new TypeError("review base SHA is invalid");
  if (
    payload.scopeSha !== undefined &&
    (typeof payload.scopeSha !== "string" ||
      !/^[0-9a-f]{64}$/.test(payload.scopeSha))
  )
    throw new TypeError("review scope is invalid");
  if (
    payload.rerunNonce !== undefined &&
    (typeof payload.rerunNonce !== "string" ||
      !/^[a-zA-Z0-9-]{1,100}$/.test(payload.rerunNonce))
  )
    throw new TypeError("review rerun nonce is invalid");
  return Object.freeze({
    ...(payload.baseSha === undefined
      ? {}
      : { baseSha: payload.baseSha as string }),
    ...(payload.baseBranch === undefined
      ? {}
      : { baseBranch: payload.baseBranch as string }),
    ...(payload.scopeSha === undefined
      ? {}
      : { scopeSha: payload.scopeSha as string }),
    ...(payload.rerunNonce === undefined
      ? {}
      : { rerunNonce: payload.rerunNonce as string }),
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
  baseBranch?: string,
  baseSha?: string,
): ReviewRequest {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(headSha)) {
    throw new TypeError("refreshed headSha must be a full Git object ID");
  }
  const normalizedHead = headSha.toLowerCase();
  return Object.freeze({
    ...request,
    ...(baseBranch === undefined ? {} : { baseBranch }),
    ...(baseSha === undefined ? {} : { baseSha }),
    deliveryId: `refresh-${createHash("sha256")
      .update(
        `${request.repository}#${request.pullRequestNumber}#${normalizedHead}`,
      )
      .digest("hex")}`,
    action: "synchronize",
    headSha: normalizedHead,
    ...(request.scopeSha === undefined
      ? {}
      : {
          scopeSha: createHash("sha256")
            .update(
              `${normalizedHead}#${baseBranch ?? request.baseBranch ?? ""}#pipeline-v2`,
            )
            .digest("hex"),
        }),
  });
}

/** State tracks a review scope rather than assuming a head uniquely identifies a PR diff. */
export function reviewScope(request: ReviewRequest): string {
  return request.scopeSha ?? request.headSha;
}
