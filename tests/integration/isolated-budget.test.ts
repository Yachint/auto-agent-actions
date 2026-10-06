import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runIsolatedReview } from "../../src/codex/isolated-runner.js";
import { createModelProxy } from "../../src/codex/model-proxy.js";
import { DEFAULT_MODEL_BUDGET, ReviewModelBudget } from "../../src/codex/model-budget.js";
import type { ModelDiagnosticEvent } from "../../src/codex/runner.js";
const exec = promisify(execFile);

describe.skipIf(process.env.RUN_ISOLATED_BUDGET_TEST !== "1")("real Codex child with simulated inference", () => {
  it("aborts an isolated tool loop immediately at its budget without credentials or publication", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aaa-budget-native-"));
    const repository = path.join(root, "repository");
    const git = (args: string[]) => exec("git", ["-C", repository, ...args]);
    let upstreamRequests = 0;
    const diagnostics: ModelDiagnosticEvent[] = [];
    try {
      await exec("git", ["init", "--initial-branch=main", repository]);
      await git(["config", "user.email", "fixture@example.invalid"]);
      await git(["config", "user.name", "Synthetic Fixture"]);
      await writeFile(path.join(repository, "a.ts"), "one\n");
      await git(["add", "a.ts"]); await git(["commit", "-m", "base"]);
      const baseSha = (await git(["rev-parse", "HEAD"])).stdout.trim();
      await writeFile(path.join(repository, "a.ts"), "changed\n");
      await git(["add", "a.ts"]); await git(["commit", "-m", "head"]);
      const headSha = (await git(["rev-parse", "HEAD"])).stdout.trim();
      const budget = new ReviewModelBudget({ ...DEFAULT_MODEL_BUDGET, maxRequestsPerInvocation: 2 });
      const started = Date.now();
      await expect(runIsolatedReview({
        worktreePath: repository, outputPath: path.join(root, "output.json"), baseSha, headSha,
        schemaPath: fileURLToPath(new URL("../../src/codex/review-coverage-schema.json", import.meta.url)),
        instructionsPath: fileURLToPath(new URL("../../src/codex/review-instructions.md", import.meta.url)),
        sandboxBinary: "/usr/local/bin/review-sandbox", model: "gpt-6.1-sol", reasoningEffort: "medium", agentThreads: 1,
        expectedPaths: ["a.ts"], prompt: "Synthetic budget test. Execute the supplied read-only tool call.", timeoutMs: 15000,
        environment: { PATH: process.env.PATH, CODEX_API_KEY: "synthetic-not-a-real-key" }, modelBudget: budget,
        modelContext: { phase: "inspection", group: 1, groups: 1 }, onModelDiagnostics: (event) => diagnostics.push(event),
      }, { createProxy: (options) => createModelProxy({ ...options, fetch: async () => {
        upstreamRequests++;
        const item = { type: "function_call", id: `fc_${upstreamRequests}`, call_id: `call_${upstreamRequests}`, name: "exec_command", arguments: JSON.stringify({ cmd: "git diff --stat refs/snapshot/base refs/snapshot/head", max_output_tokens: 64 }), status: "completed" };
        const response = { id: `resp_${upstreamRequests}`, object: "response", status: "completed", model: "gpt-6.1-sol", output: [item], usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 50 }, output_tokens: 10 } };
        const events = [
          { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
          { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } },
          { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments },
          { type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: item.arguments },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response },
        ];
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
      } }) })).rejects.toMatchObject({ name: "ModelBudgetExceededError", reason: "invocation-request-count" });
      expect(upstreamRequests).toBe(2);
      expect(Date.now() - started).toBeLessThan(15000);
      expect(diagnostics.filter((event) => event.kind === "request")).toHaveLength(2);
      expect(diagnostics.at(-1)).toMatchObject({ kind: "invocation", phase: "inspection", group: 1, diagnostics: { upstreamRequests: 2, inputTokens: 200, cachedInputTokens: 100, outputTokens: 20, successfulCommands: 2 } });
      expect(JSON.stringify(diagnostics)).not.toContain("synthetic-not-a-real-key");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 20000);
});
