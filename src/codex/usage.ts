import { modelLimitFromResponse, type ModelUsageLimitError } from "./model-limit.js";

export interface CodexUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
}

export interface ToolFailureDiagnostics {
  readonly exitCodes: number[];
  readonly categories: string[];
}

/** Drops all content events. A bounded line buffer cannot retain arbitrary tool output. */
export class UsageCollector {
  #buffer = "";
  #dropping = false;
  #totals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  #limit: ModelUsageLimitError | undefined;
  readonly #exitCodes = new Set<number>();
  readonly #categories = new Set<string>();
  push(chunk: Buffer): void {
    for (const part of chunk.toString("utf8").split(/(?<=\n)/)) {
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
  totals(): CodexUsage {
    return { ...this.#totals };
  }
  limit(): ModelUsageLimitError | undefined {
    return this.#limit;
  }
  toolFailures(): ToolFailureDiagnostics {
    return { exitCodes: [...this.#exitCodes], categories: [...this.#categories] };
  }
  #read(line: string): void {
    try {
      const value = JSON.parse(line) as {
        type?: string;
        usage?: Record<string, unknown>;
        item?: { type?: string; exit_code?: unknown; aggregated_output?: unknown };
      };
      const item = value.item;
      if (value.type === "item.completed" && item?.type === "command_execution" &&
        typeof item.exit_code === "number" && Number.isInteger(item.exit_code) &&
        item.exit_code > 0 && item.exit_code <= 255) {
        if (this.#exitCodes.size < 16) this.#exitCodes.add(item.exit_code);
        if (typeof item.aggregated_output === "string") {
          for (const [name, pattern] of [
            ["command-not-found", /command not found|not found:|no such file or directory/i],
            ["permission-denied", /permission denied|operation not permitted/i],
            ["git-missing-object", /bad object|unknown revision|invalid object/i],
            ["git-ownership", /dubious ownership/i],
            ["git-lock", /index\.lock|unable to create.*lock/i],
          ] as const) {
            if (pattern.test(item.aggregated_output)) this.#categories.add(name);
          }
        }
      }
      if (value.type === "turn.failed" || value.type === "error") {
        const limit = modelLimitFromResponse(value);
        if (limit && (!this.#limit || limit.retryAt > this.#limit.retryAt))
          this.#limit = limit;
      }
      if (value.type !== "turn.completed" || !value.usage) return;
      for (const [target, source] of [
        ["inputTokens", "input_tokens"],
        ["cachedInputTokens", "cached_input_tokens"],
        ["outputTokens", "output_tokens"],
      ] as const) {
        const count = value.usage[source];
        if (
          typeof count === "number" &&
          Number.isSafeInteger(count) &&
          count >= 0 &&
          Number.isSafeInteger(this.#totals[target] + count)
        )
          this.#totals[target] += count;
      }
    } catch {
      /* Content and malformed events do not become metrics. */
    }
  }
}
