import { CodexExecutionError } from "../codex/runner.js";
import { ModelProxyPolicyError } from "../codex/model-proxy.js";
import { ModelBudgetExceededError } from "../codex/model-budget.js";

/** A retry cannot repair these failures; preserve the durable exhausted scope. */
export function isTerminalInspectionFailure(error: unknown): boolean {
  return (error instanceof CodexExecutionError && error.failureKind === "blocked") ||
    error instanceof ModelProxyPolicyError || error instanceof ModelBudgetExceededError;
}
