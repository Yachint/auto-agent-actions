import { loadReviewIsolationConfig, loadReviewAgentThreads, loadReviewBatchFiles } from "../config/runtime.js";
import { buildReviewPrompt } from "../codex/prompt.js";
import { buildCodexArgs } from "../codex/runner.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** Shared by all scheduling processes. Includes only trusted policy and public settings. */
export function reviewPolicyHash(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const batchFiles = loadReviewBatchFiles(environment);
  return createHash("sha256")
    .update(
      JSON.stringify([
        environment.REVIEW_POLICY_VERSION ?? "pipeline-v2",
        String(
          loadReviewIsolationConfig(environment).sandboxBinary !== undefined,
        ),
        environment.CODEX_TIMEOUT_MS ?? "1800000",
        buildReviewPrompt({
          repository: "policy/template",
          pullRequestNumber: 1,
          baseSha: "a".repeat(40),
          mergeBaseSha: "c".repeat(40),
          headSha: "b".repeat(40),
        }),
        buildCodexArgs({
          worktreePath: "/review",
          schemaPath: "/trusted/schema",
          instructionsPath: "/trusted/instructions",
          outputPath: "/result",
          model: environment.CODEX_MODEL ?? "gpt-6.1-sol",
          reasoningEffort: "high",
          agentThreads: loadReviewAgentThreads(environment),
        }),
        environment.REVIEW_FINDING_CONTINUITY ?? "false",
        environment.REVIEW_PUBLISH_SUMMARY_WITHOUT_FINDINGS ?? "true",
        environment.REVIEW_VERIFY_FINDINGS ?? "false",
        environment.REVIEW_ADAPTIVE_EFFORT ?? "false",
        readFileSync(
          new URL("../codex/review-instructions.md", import.meta.url),
          "utf8",
        ),
        readFileSync(
          new URL("../codex/review-coverage-schema.json", import.meta.url),
          "utf8",
        ),
        environment.CODEX_CLI_VERSION ?? "0.155.1",
        environment.CODEX_MODEL ?? "gpt-6.1-sol",
        environment.CODEX_REASONING_EFFORT ?? "high",
        environment.REVIEW_MINIMUM_CONFIDENCE ?? "0.8",
        environment.REVIEW_MAXIMUM_INLINE_COMMENTS ?? "20",
        environment.REVIEW_BLOCKING_PRIORITY ?? "1",
        ...(batchFiles === undefined ? [] : ["sequential-checkpoints-v1", batchFiles]),
      ]),
    )
    .digest("hex");
}
