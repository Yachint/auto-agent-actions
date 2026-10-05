const DEFAULT_QUOTA_DELAY_MS = 5 * 60 * 60 * 1000;
const MAX_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

/** Safe metadata only: upstream messages, prompts and credentials never enter errors. */
export class ModelUsageLimitError extends Error {
  constructor(readonly retryAt: number) {
    super("model usage unavailable until cooldown expires");
    this.name = "ModelUsageLimitError";
  }
}

export function modelLimitFromResponse(
  value: unknown,
  status?: number,
  retryAfter?: string | null,
  now = Date.now(),
): ModelUsageLimitError | undefined {
  const root = record(value);
  const response = record(root?.response);
  const error = record(root?.error) ?? record(response?.error) ?? root;
  const code = error?.code ?? error?.type;
  const quota =
    ["usage_limit_reached", "usage_limit_exceeded", "insufficient_quota"].includes(String(code)) ||
    (typeof error?.message === "string" &&
      /you(?:'|’)?ve hit your usage limit/i.test(error.message));
  if (!quota && status !== 429 && code !== "rate_limit_exceeded") return;
  const delays: number[] = [];
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const delay = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(retryAfter) - now;
    if (Number.isFinite(delay) && delay > 0) delays.push(delay);
  }
  if (typeof error?.resets_at === "number" && Number.isFinite(error.resets_at))
    delays.push(error.resets_at * 1000 - now);
  for (const field of ["resets_in_seconds", "retry_after_seconds"]) {
    const seconds = error?.[field];
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0)
      delays.push(seconds * 1000);
  }
  const valid = delays.filter((delay) => Number.isFinite(delay) && delay > 0);
  const delay = valid.length
    ? Math.max(...valid)
    : quota ? DEFAULT_QUOTA_DELAY_MS : 60_000;
  return new ModelUsageLimitError(
    now + Math.ceil(Math.min(MAX_DELAY_MS, Math.max(1000, delay))),
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value))
    return value as Record<string, unknown>;
}
