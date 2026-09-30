export interface CodexUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
}

/** Drops all content events. A bounded line buffer cannot retain arbitrary tool output. */
export class UsageCollector {
  #buffer = "";
  #dropping = false;
  #totals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
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
  #read(line: string): void {
    try {
      const value = JSON.parse(line) as {
        type?: string;
        usage?: Record<string, unknown>;
      };
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
