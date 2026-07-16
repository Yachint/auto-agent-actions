import { createHash } from "node:crypto";

export type ReviewStatus = "queued" | "running" | "reviewed" | "failed";

export interface ReviewState {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly latestRequestedHeadSha: string;
  readonly currentlyRunningHeadSha: string | null;
  readonly lastReviewedHeadSha: string | null;
  readonly status: ReviewStatus;
  readonly updatedAt: string;
}

export interface ReviewStateStore {
  recordRequested(repository: string, pullRequestNumber: number, headSha: string): Promise<boolean>;
  enqueueFailed(repository: string, pullRequestNumber: number, headSha: string): Promise<void>;
  tryStart(repository: string, pullRequestNumber: number, headSha: string): Promise<boolean>;
  canPublish(repository: string, pullRequestNumber: number, headSha: string): Promise<boolean>;
  complete(repository: string, pullRequestNumber: number, headSha: string): Promise<boolean>;
  fail(repository: string, pullRequestNumber: number, headSha: string): Promise<void>;
  get(repository: string, pullRequestNumber: number): Promise<ReviewState | null>;
}

export class InMemoryReviewStateStore implements ReviewStateStore {
  readonly #states = new Map<string, ReviewState>();
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  async recordRequested(repository: string, pullRequestNumber: number, headSha: string): Promise<boolean> {
    validateIdentity(repository, pullRequestNumber, headSha);
    const key = reviewConcurrencyKey(repository, pullRequestNumber);
    const previous = this.#states.get(key);
    if (
      previous?.latestRequestedHeadSha === headSha.toLowerCase() &&
      previous.status !== "failed"
    ) {
      return false;
    }
    this.#states.set(key, {
      repository,
      pullRequestNumber,
      latestRequestedHeadSha: headSha.toLowerCase(),
      currentlyRunningHeadSha: previous?.currentlyRunningHeadSha ?? null,
      lastReviewedHeadSha: previous?.lastReviewedHeadSha ?? null,
      status: previous?.currentlyRunningHeadSha === null || previous === undefined ? "queued" : "running",
      updatedAt: this.#now().toISOString(),
    });
    return true;
  }

  async tryStart(repository: string, pullRequestNumber: number, headSha: string): Promise<boolean> {
    const state = this.#requireState(repository, pullRequestNumber, headSha);
    const normalizedHead = headSha.toLowerCase();
    if (
      state.latestRequestedHeadSha !== normalizedHead ||
      (state.lastReviewedHeadSha === normalizedHead && state.status === "reviewed") ||
      (state.currentlyRunningHeadSha !== null && state.currentlyRunningHeadSha !== normalizedHead)
    ) {
      return false;
    }
    this.#set(state, { currentlyRunningHeadSha: normalizedHead, status: "running" });
    return true;
  }

  async enqueueFailed(repository: string, pullRequestNumber: number, headSha: string): Promise<void> {
    const state = this.#requireState(repository, pullRequestNumber, headSha);
    const normalizedHead = headSha.toLowerCase();
    if (state.latestRequestedHeadSha !== normalizedHead) return;
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

  async canPublish(repository: string, pullRequestNumber: number, headSha: string): Promise<boolean> {
    const state = this.#states.get(reviewConcurrencyKey(repository, pullRequestNumber));
    const normalizedHead = headSha.toLowerCase();
    return (
      state?.latestRequestedHeadSha === normalizedHead &&
      state.currentlyRunningHeadSha === normalizedHead &&
      state.status === "running"
    );
  }

  async complete(repository: string, pullRequestNumber: number, headSha: string): Promise<boolean> {
    const state = this.#requireState(repository, pullRequestNumber, headSha);
    const normalizedHead = headSha.toLowerCase();
    if (
      state.latestRequestedHeadSha !== normalizedHead ||
      state.currentlyRunningHeadSha !== normalizedHead
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
    return true;
  }

  async fail(repository: string, pullRequestNumber: number, headSha: string): Promise<void> {
    const state = this.#requireState(repository, pullRequestNumber, headSha);
    const normalizedHead = headSha.toLowerCase();
    if (
      state.currentlyRunningHeadSha === null &&
      state.latestRequestedHeadSha === normalizedHead &&
      state.status === "queued"
    ) {
      this.#set(state, { status: "failed" });
      return;
    }
    if (state.currentlyRunningHeadSha !== normalizedHead) return;
    this.#set(state, {
      currentlyRunningHeadSha: null,
      status: state.latestRequestedHeadSha === normalizedHead ? "failed" : "queued",
    });
  }

  async get(repository: string, pullRequestNumber: number): Promise<ReviewState | null> {
    validateIdentity(repository, pullRequestNumber, "0".repeat(40));
    return this.#states.get(reviewConcurrencyKey(repository, pullRequestNumber)) ?? null;
  }

  #requireState(repository: string, pullRequestNumber: number, headSha: string): ReviewState {
    validateIdentity(repository, pullRequestNumber, headSha);
    const state = this.#states.get(reviewConcurrencyKey(repository, pullRequestNumber));
    if (state === undefined) throw new Error("review state does not exist");
    return state;
  }

  #set(state: ReviewState, changes: Partial<ReviewState>): void {
    this.#states.set(reviewConcurrencyKey(state.repository, state.pullRequestNumber), {
      ...state,
      ...changes,
      updatedAt: this.#now().toISOString(),
    });
  }
}

export function reviewConcurrencyKey(repository: string, pullRequestNumber: number): string {
  return `${repository}#${pullRequestNumber}`;
}

export function reviewStateRedisKey(repository: string, pullRequestNumber: number): string {
  return `auto-agent-actions:review-state:${createHash("sha256")
    .update(reviewConcurrencyKey(repository, pullRequestNumber))
    .digest("hex")}`;
}

function validateIdentity(repository: string, pullRequestNumber: number, headSha: string): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(repository)) {
    throw new TypeError("repository must use owner/name format");
  }
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
    throw new TypeError("pullRequestNumber must be a positive integer");
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(headSha)) {
    throw new TypeError("headSha must be a full Git object ID");
  }
}
