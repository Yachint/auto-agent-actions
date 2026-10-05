import { StringDecoder } from "node:string_decoder";
import type { CodexUsage } from "./usage.js";
import { modelLimitFromResponse, type ModelUsageLimitError } from "./model-limit.js";

/** Observe bounded SSE/JSON events, forwarding bytes unchanged and retaining no content. */
export class ModelResponseObserver {
  readonly #decoder = new StringDecoder("utf8");
  #buffer = "";
  #dropping = false;
  #accounted = false;

  constructor(
    readonly onUsage: ((usage: CodexUsage) => void) | undefined,
    readonly onLimit: (error: ModelUsageLimitError) => void,
    readonly status: number,
    readonly retryAfter: string | null,
  ) {}

  push(chunk: Buffer): void {
    for (const part of this.#decoder.write(chunk).split(/(?<=\n)/)) {
      if (!this.#dropping) this.#buffer += part;
      if (Buffer.byteLength(this.#buffer) > 64 * 1024) {
        this.#buffer = "";
        this.#dropping = true;
      }
      if (!part.endsWith("\n")) continue;
      if (!this.#dropping) this.#read(this.#buffer);
      this.#buffer = "";
      this.#dropping = false;
    }
  }

  finish(): void {
    this.#buffer += this.#decoder.end();
    if (!this.#dropping) this.#read(this.#buffer);
    this.#buffer = "";
  }

  #read(line: string): void {
    try {
      const value = JSON.parse(line.replace(/^data:\s*/, "")) as Record<string, unknown>;
      const limit = modelLimitFromResponse(value, this.status, this.retryAfter);
      if (limit) this.onLimit(limit);
      if (this.#accounted ||
        !["response.completed", "response.failed", "response.incomplete"].includes(String(value.type)))
        return;
      const response = value.response as { usage?: Record<string, unknown> } | undefined;
      const usage = response?.usage;
      if (!usage) return;
      const details = usage.input_tokens_details as { cached_tokens?: unknown } | undefined;
      const counts = [
        usage.input_tokens,
        details?.cached_tokens ?? 0,
        usage.output_tokens,
      ];
      if (!counts.every((count) =>
        typeof count === "number" && Number.isSafeInteger(count) && count >= 0))
        return;
      this.#accounted = true;
      this.onUsage?.({
        inputTokens: counts[0] as number,
        cachedInputTokens: counts[1] as number,
        outputTokens: counts[2] as number,
      });
    } catch {
      // Malformed/content events are never logged or persisted.
    }
  }
}
