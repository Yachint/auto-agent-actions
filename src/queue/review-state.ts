import { createHash } from "node:crypto";

export type ReviewStatus =
  | "queued"
  | "running"
  | "publishing"
  | "reviewed"
  | "failed";

export interface ReviewState {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly latestRequestedHeadSha: string;
  readonly currentlyRunningHeadSha: string | null;
  readonly lastReviewedHeadSha: string | null;
  readonly status: ReviewStatus;
  readonly updatedAt: string;
  readonly publicationArtifact?: string;
  readonly attemptId?: string;
  readonly schedulingRequest?: string;
  readonly analysisExhaustedScope?: string;
  readonly lastPublication?: {
    readonly scopeSha: string;
    readonly reviewId: number;
  };
}

export interface ReviewStateStore {
  exhaustAnalysis(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    attemptId?: string,
  ): Promise<boolean>;
  recordRequested(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    attemptId?: string,
    schedulingRequest?: string,
  ): Promise<boolean>;
  recordReceipt(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    reviewId: number,
  ): Promise<void>;
  recoverExpired(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    cutoff: string,
  ): Promise<boolean>;
  renew(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    attemptId: string,
  ): Promise<boolean>;
  handoff(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    artifact: string,
    attemptId?: string,
  ): Promise<boolean>;
  enqueueFailed(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    attemptId?: string,
  ): Promise<void>;
  tryStart(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    attemptId?: string,
  ): Promise<boolean>;
  canPublish(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    attemptId?: string,
  ): Promise<boolean>;
  complete(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    attemptId?: string,
  ): Promise<boolean>;
  fail(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    attemptId?: string,
  ): Promise<void>;
  get(
    repository: string,
    pullRequestNumber: number,
  ): Promise<ReviewState | null>;
}

export class InMemoryReviewStateStore implements ReviewStateStore {
  readonly #states = new Map<string, ReviewState>();
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  async recordRequested(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    attemptId?: string,
    schedulingRequest?: string,
  ): Promise<boolean> {
    validateIdentity(repository, pullRequestNumber, headSha);
    const key = reviewConcurrencyKey(repository, pullRequestNumber);
    const previous = this.#states.get(key);
    if (previous?.analysisExhaustedScope === headSha.toLowerCase()) return false;
    if (
      previous?.latestRequestedHeadSha === headSha.toLowerCase() &&
      previous.status !== "failed"
    ) {
      return false;
    }
    this.#states.set(key, {
      repository,
      pullRequestNumber,
      ...(previous?.lastPublication === undefined
        ? {}
        : { lastPublication: previous.lastPublication }),
      ...(schedulingRequest === undefined ? {} : { schedulingRequest }),
      ...(previous?.analysisExhaustedScope === undefined
        ? {}
        : { analysisExhaustedScope: previous.analysisExhaustedScope }),
      latestRequestedHeadSha: headSha.toLowerCase(),
      currentlyRunningHeadSha: null,
      lastReviewedHeadSha: previous?.lastReviewedHeadSha ?? null,
      status: "queued",
      updatedAt: this.#now().toISOString(),
    });
    return true;
  }

  async tryStart(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    attemptId?: string,
  ): Promise<boolean> {
    const state = this.#requireState(repository, pullRequestNumber, headSha);
    const normalizedHead = headSha.toLowerCase();
    if (
      state.latestRequestedHeadSha !== normalizedHead ||
      state.analysisExhaustedScope === normalizedHead ||
      state.status === "publishing" ||
      (state.lastReviewedHeadSha === normalizedHead &&
        state.status === "reviewed") ||
      state.currentlyRunningHeadSha !== null
    ) {
      return false;
    }
    this.#set(state, {
      currentlyRunningHeadSha: normalizedHead,
      status: "running",
      ...(attemptId === undefined ? {} : { attemptId }),
    });
    return true;
  }

  async recordReceipt(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    reviewId: number,
  ): Promise<void> {
    const state = this.#requireState(repository, pullRequestNumber, headSha);
    if (!Number.isSafeInteger(reviewId) || reviewId < 1)
      throw new TypeError("invalid review receipt");
    if (state.latestRequestedHeadSha === headSha)
      this.#set(state, { lastPublication: { scopeSha: headSha, reviewId } });
  }

  async exhaustAnalysis(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    attemptId?: string,
  ): Promise<boolean> {
    const state = this.#requireState(repository, pullRequestNumber, headSha);
    const scope = headSha.toLowerCase();
    if (
      state.latestRequestedHeadSha !== scope ||
      (attemptId !== undefined && state.attemptId !== attemptId) ||
      state.status === "reviewed" ||
      state.status === "publishing"
    ) return false;
    this.#set(state, {
      analysisExhaustedScope: scope,
      currentlyRunningHeadSha: null,
      status: "failed",
    });
    return true;
  }

  async recoverExpired(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    cutoff: string,
  ): Promise<boolean> {
    const state = this.#requireState(repository, pullRequestNumber, headSha);
    if (!Number.isFinite(Date.parse(cutoff)))
      throw new TypeError("invalid lease cutoff");
    if (
      state.latestRequestedHeadSha !== headSha ||
      state.status !== "running" ||
      state.updatedAt > cutoff
    )
      return false;
    this.#set(state, { currentlyRunningHeadSha: null, status: "failed" });
    return true;
  }

  async renew(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    attemptId: string,
  ): Promise<boolean> {
    const state = this.#requireState(repository, pullRequestNumber, headSha);
    if (
      state.latestRequestedHeadSha !== headSha ||
      state.attemptId !== attemptId ||
      state.status !== "running"
    )
      return false;
    this.#set(state, {});
    return true;
  }

  async handoff(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    artifact: string,
    attemptId?: string,
  ): Promise<boolean> {
    const state = this.#requireState(repository, pullRequestNumber, headSha);
    if (
      (attemptId !== undefined && state.attemptId !== attemptId) ||
      state.latestRequestedHeadSha !== headSha ||
      state.currentlyRunningHeadSha !== headSha
    )
      return false;
    this.#set(state, {
      currentlyRunningHeadSha: null,
      status: "publishing",
      publicationArtifact: artifact,
    });
    return true;
  }

  async enqueueFailed(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    attemptId?: string,
  ): Promise<void> {
    const state = this.#requireState(repository, pullRequestNumber, headSha);
    const normalizedHead = headSha.toLowerCase();
    if (
      state.latestRequestedHeadSha !== normalizedHead ||
      state.status !== "queued"
    )
      return;
    if (
      state.currentlyRunningHeadSha !== null &&
      state.currentlyRunningHeadSha !== normalizedHead
    ) {
      this.#set(state, {
        latestRequestedHeadSha: state.currentlyRunningHeadSha,
        status: "running",
      });
      return;
    }
    this.#set(state, { status: "failed" });
  }

  async canPublish(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    attemptId?: string,
  ): Promise<boolean> {
    const state = this.#states.get(
      reviewConcurrencyKey(repository, pullRequestNumber),
    );
    const normalizedHead = headSha.toLowerCase();
    return (
      (attemptId === undefined || state?.attemptId === attemptId) &&
      state?.latestRequestedHeadSha === normalizedHead &&
      (state.currentlyRunningHeadSha === normalizedHead ||
        state.status === "publishing") &&
      (state.status === "running" || state.status === "publishing")
    );
  }

  async complete(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    attemptId?: string,
  ): Promise<boolean> {
    const state = this.#requireState(repository, pullRequestNumber, headSha);
    const normalizedHead = headSha.toLowerCase();
    if (attemptId !== undefined && state.attemptId !== attemptId) return false;
    if (
      state.latestRequestedHeadSha !== normalizedHead ||
      (state.currentlyRunningHeadSha !== normalizedHead &&
        state.status !== "publishing")
    ) {
      if (state.currentlyRunningHeadSha === normalizedHead) {
        this.#set(state, { currentlyRunningHeadSha: null, status: "queued" });
      }
      return false;
    }
    this.#set(state, {
      currentlyRunningHeadSha: null,
      lastReviewedHeadSha: normalizedHead,
      status: "reviewed",
    });
    const completed = this.#states.get(
      reviewConcurrencyKey(repository, pullRequestNumber),
    )!;
    const {
      publicationArtifact: _artifact,
      attemptId: _attempt,
      ...retained
    } = completed;
    this.#states.set(
      reviewConcurrencyKey(repository, pullRequestNumber),
      retained,
    );
    return true;
  }

  async fail(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    attemptId?: string,
  ): Promise<void> {
    const state = this.#requireState(repository, pullRequestNumber, headSha);
    const normalizedHead = headSha.toLowerCase();
    if (attemptId !== undefined && state.attemptId !== attemptId) return;
    if (
      state.currentlyRunningHeadSha === null &&
      state.latestRequestedHeadSha === normalizedHead &&
      state.status === "queued"
    ) {
      this.#set(state, { status: "failed" });
      return;
    }
    if (
      state.currentlyRunningHeadSha !== normalizedHead &&
      !(
        state.latestRequestedHeadSha === normalizedHead &&
        state.status === "publishing"
      )
    )
      return;
    this.#set(state, {
      currentlyRunningHeadSha: null,
      status:
        state.latestRequestedHeadSha === normalizedHead ? "failed" : "queued",
    });
  }

  async get(
    repository: string,
    pullRequestNumber: number,
  ): Promise<ReviewState | null> {
    validateIdentity(repository, pullRequestNumber, "0".repeat(40));
    return (
      this.#states.get(reviewConcurrencyKey(repository, pullRequestNumber)) ??
      null
    );
  }

  #requireState(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
  ): ReviewState {
    validateIdentity(repository, pullRequestNumber, headSha);
    const state = this.#states.get(
      reviewConcurrencyKey(repository, pullRequestNumber),
    );
    if (state === undefined) throw new Error("review state does not exist");
    return state;
  }

  #set(state: ReviewState, changes: Partial<ReviewState>): void {
    this.#states.set(
      reviewConcurrencyKey(state.repository, state.pullRequestNumber),
      {
        ...state,
        ...changes,
        updatedAt: this.#now().toISOString(),
      },
    );
  }
}

export function reviewConcurrencyKey(
  repository: string,
  pullRequestNumber: number,
): string {
  return `${repository}#${pullRequestNumber}`;
}

export function reviewStateRedisKey(
  repository: string,
  pullRequestNumber: number,
): string {
  return `auto-agent-actions:review-state:${createHash("sha256")
    .update(reviewConcurrencyKey(repository, pullRequestNumber))
    .digest("hex")}`;
}

function validateIdentity(
  repository: string,
  pullRequestNumber: number,
  headSha: string,
): void {
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(
      repository,
    )
  ) {
    throw new TypeError("repository must use owner/name format");
  }
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
    throw new TypeError("pullRequestNumber must be a positive integer");
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(headSha)) {
    throw new TypeError("headSha must be a full Git object ID");
  }
}
