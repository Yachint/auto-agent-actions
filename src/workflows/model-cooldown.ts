import { Worker } from "bullmq";
import { ModelUsageLimitError } from "../codex/model-limit.js";
import type { ModelCooldownStore } from "../queue/model-cooldown.js";

/** Rate-limit deferrals leave jobs pending without consuming attempts or notifying PRs. */
export async function runWithModelCooldown<T>(
  operation: () => Promise<T>,
  options: {
    store: Pick<ModelCooldownStore, "remainingMs" | "defer">;
    rateLimit: (delayMs: number) => Promise<void>;
    onBlocked: (delayMs: number, newlyLimited: boolean) => Promise<void>;
  },
): Promise<T> {
  const pause = async (delayMs: number, newlyLimited: boolean): Promise<never> => {
    await options.onBlocked(delayMs, newlyLimited);
    await options.rateLimit(delayMs);
    throw Worker.RateLimitError();
  };
  const remaining = await options.store.remainingMs();
  if (remaining > 0) return pause(remaining, false);
  try {
    return await operation();
  } catch (error) {
    const failure =
      error instanceof Error && error.cause instanceof ModelUsageLimitError
        ? error.cause
        : error;
    if (!(failure instanceof ModelUsageLimitError)) throw error;
    return pause(await options.store.defer(failure.retryAt), true);
  }
}
