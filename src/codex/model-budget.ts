import type { CodexUsage } from "./usage.js";

export interface ModelBudgetLimits {
  readonly maxRequests: number;
  readonly maxRequestsPerInvocation: number;
  readonly maxRequestBytes: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
}

export const DEFAULT_MODEL_BUDGET: ModelBudgetLimits = Object.freeze({
  maxRequests: 24,
  maxRequestsPerInvocation: 8,
  maxRequestBytes: 64 * 1024,
  maxInputTokens: 200_000,
  maxOutputTokens: 10_000,
});

export type ModelBudgetReason = "request-count" | "invocation-request-count" | "request-size" |
  "input-tokens" | "output-tokens" | "unobserved-usage";

export class ModelBudgetExceededError extends Error {
  constructor(readonly reason: ModelBudgetReason, readonly totals: CodexUsage & { requests: number }) {
    super("review model budget prevented further spending");
    this.name = "ModelBudgetExceededError";
  }
}

/** One attempt, including all groups and verification. Serializes upstream admission. */
export class ReviewModelBudget {
  readonly limits: ModelBudgetLimits;
  readonly #controller = new AbortController();
  #failure: ModelBudgetExceededError | undefined;
  #totals = { requests: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  #turn: Promise<void> = Promise.resolve();

  constructor(limits: ModelBudgetLimits = DEFAULT_MODEL_BUDGET) {
    for (const [name, ceiling] of Object.entries({
      maxRequests: 200, maxRequestsPerInvocation: 200,
      maxRequestBytes: 2 * 1024 * 1024,
      maxInputTokens: 10_000_000, maxOutputTokens: 1_000_000,
    })) {
      const value = limits[name as keyof ModelBudgetLimits];
      if (!Number.isSafeInteger(value) || value < 1 || value > ceiling)
        throw new TypeError(`invalid model budget ${name}`);
    }
    this.limits = Object.freeze({ ...limits });
  }

  get signal(): AbortSignal { return this.#controller.signal; }
  failure(): ModelBudgetExceededError | undefined { return this.#failure; }
  totals(): CodexUsage & { requests: number } { return { ...this.#totals }; }

  deny(reason: ModelBudgetReason): ModelBudgetExceededError {
    this.#failure ??= new ModelBudgetExceededError(reason, this.totals());
    this.#controller.abort();
    return this.#failure;
  }

  observe(usage: CodexUsage): void {
    if (![usage.inputTokens, usage.cachedInputTokens, usage.outputTokens].every((count) =>
      Number.isSafeInteger(count) && count >= 0) || usage.cachedInputTokens > usage.inputTokens) {
      this.deny("unobserved-usage"); return;
    }
    for (const name of ["inputTokens", "cachedInputTokens", "outputTokens"] as const)
      this.#totals[name] = Math.min(Number.MAX_SAFE_INTEGER, this.#totals[name] + usage[name]);
    if (this.#totals.inputTokens > this.limits.maxInputTokens) this.deny("input-tokens");
    else if (this.#totals.outputTokens > this.limits.maxOutputTokens) this.deny("output-tokens");
  }

  invocation(): { acquire: () => Promise<() => void> } {
    let requests = 0;
    return { acquire: async () => {
      const previous = this.#turn;
      let release!: () => void;
      this.#turn = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        if (this.#failure) throw this.#failure;
        if (requests >= this.limits.maxRequestsPerInvocation) throw this.deny("invocation-request-count");
        if (this.#totals.requests >= this.limits.maxRequests) throw this.deny("request-count");
        if (this.#totals.inputTokens >= this.limits.maxInputTokens) throw this.deny("input-tokens");
        if (this.#totals.outputTokens >= this.limits.maxOutputTokens) throw this.deny("output-tokens");
        requests++;
        this.#totals.requests++;
        return release;
      } catch (error) { release(); throw error; }
    } };
  }
}
