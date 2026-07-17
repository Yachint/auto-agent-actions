import { spawn } from "node:child_process";
import { readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";

import {
  parseReviewOutput,
  type CompletedReviewOutput,
} from "../validation/review-output.js";

const DEFAULT_MAX_PROCESS_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_MAX_REVIEW_OUTPUT_BYTES = 1024 * 1024;
const FORCE_KILL_DELAY_MS = 1_000;

export type ReasoningEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface CodexRunnerOptions {
  worktreePath: string;
  schemaPath: string;
  instructionsPath: string;
  outputPath: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  prompt: string;
  timeoutMs: number;
  codexBinary?: string;
  environment?: NodeJS.ProcessEnv;
  executor?: ProcessExecutor;
  /** Maximum combined stdout/stderr bytes retained for diagnostics. */
  maxProcessOutputBytes?: number;
  maxReviewOutputBytes?: number;
}

export interface CodexSandboxPreflightOptions {
  codexBinary?: string;
  environment?: NodeJS.ProcessEnv;
  executor?: ProcessExecutor;
  timeoutMs?: number;
}

export interface ProcessInvocation {
  command: string;
  args: string[];
  stdin: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputTruncated: boolean;
}

export type ProcessExecutor = (
  invocation: ProcessInvocation,
) => Promise<ProcessResult>;

export class CodexExecutionError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(
    message: string,
    result: Pick<ProcessResult, "exitCode" | "signal"> = {
      exitCode: null,
      signal: null,
    },
  ) {
    super(message);
    this.name = "CodexExecutionError";
    this.exitCode = result.exitCode;
    this.signal = result.signal;
  }
}

export async function runCodexReview(
  options: CodexRunnerOptions,
): Promise<CompletedReviewOutput> {
  validateOptions(options);
  await assertTrustedPaths(options);

  const maxProcessOutputBytes =
    options.maxProcessOutputBytes ?? DEFAULT_MAX_PROCESS_OUTPUT_BYTES;
  const maxReviewOutputBytes =
    options.maxReviewOutputBytes ?? DEFAULT_MAX_REVIEW_OUTPUT_BYTES;
  const executor = options.executor ?? executeProcess;

  await rm(options.outputPath, { force: true });

  const result = await executor({
    command: options.codexBinary ?? "codex",
    args: buildCodexArgs(options),
    stdin: options.prompt,
    environment: createCodexEnvironment(options.environment ?? process.env),
    timeoutMs: options.timeoutMs,
    maxOutputBytes: maxProcessOutputBytes,
  });

  if (result.timedOut) {
    throw new CodexExecutionError(
      `Codex review exceeded its ${options.timeoutMs}ms timeout`,
      result,
    );
  }

  if (result.exitCode !== 0) {
    throw new CodexExecutionError("Codex review process failed", result);
  }

  let outputStats;
  try {
    outputStats = await stat(options.outputPath);
  } catch {
    throw new CodexExecutionError("Codex did not produce a review output file");
  }

  if (!outputStats.isFile()) {
    throw new CodexExecutionError("Codex review output is not a regular file");
  }

  if (outputStats.size > maxReviewOutputBytes) {
    throw new CodexExecutionError(
      `Codex review output exceeded ${maxReviewOutputBytes} bytes`,
    );
  }

  const output = parseReviewOutput(await readFile(options.outputPath, "utf8"));
  if (output.status !== "completed") {
    throw new CodexExecutionError("Codex could not complete the requested review");
  }
  return output;
}

export async function verifyCodexReadOnlySandbox(
  options: CodexSandboxPreflightOptions = {},
): Promise<void> {
  const executor = options.executor ?? executeProcess;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const result = await executor({
    command: options.codexBinary ?? "codex",
    args: [
      "sandbox",
      "-c",
      'sandbox_mode="read-only"',
      "-c",
      "features.use_legacy_landlock=true",
      "--",
      "/bin/sh",
      "-c",
      "if /bin/sh -c ': > /tmp/auto-agent-actions-sandbox-write-probe'; then rm -f /tmp/auto-agent-actions-sandbox-write-probe; exit 1; else exit 0; fi",
    ],
    stdin: "",
    environment: createCodexEnvironment(options.environment ?? process.env),
    timeoutMs,
    maxOutputBytes: 64 * 1024,
  });

  if (
    result.exitCode !== 0 ||
    result.signal !== null ||
    result.timedOut ||
    result.outputTruncated
  ) {
    throw new CodexExecutionError(
      `Codex read-only sandbox preflight failed: ${describePreflightFailure(result)}`,
      result,
    );
  }
}

function describePreflightFailure(result: ProcessResult): string {
  if (result.timedOut) return "timed out";
  if (result.outputTruncated) return "diagnostic output limit exceeded";
  if (result.signal !== null) return `terminated by ${result.signal}`;

  const diagnostic = sanitizePreflightDiagnostic(result.stderr || result.stdout);
  if (diagnostic) return diagnostic;
  return `exit code ${result.exitCode ?? "unknown"}`;
}

function sanitizePreflightDiagnostic(value: string): string {
  return value
    .replace(/[^\x20-\x7e]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 512);
}

export function buildCodexArgs(
  options: Pick<
    CodexRunnerOptions,
    | "worktreePath"
    | "schemaPath"
    | "instructionsPath"
    | "outputPath"
    | "model"
    | "reasoningEffort"
  >,
): string[] {
  return [
    "exec",
    "--cd",
    options.worktreePath,
    "--model",
    options.model,
    "--sandbox",
    "read-only",
    "-c",
    "features.use_legacy_landlock=true",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "--color",
    "never",
    "--output-schema",
    options.schemaPath,
    "--output-last-message",
    options.outputPath,
    "-c",
    'approval_policy="never"',
    "-c",
    'web_search="disabled"',
    "-c",
    "features.apps=false",
    "-c",
    `model_reasoning_effort=${JSON.stringify(options.reasoningEffort)}`,
    "-c",
    `model_instructions_file=${JSON.stringify(options.instructionsPath)}`,
    "-",
  ];
}

export function createCodexEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const allowedNames = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "CODEX_HOME",
    "CODEX_API_KEY",
    "SYSTEMROOT",
    "COMSPEC",
    "PATHEXT",
  ];
  const environment: NodeJS.ProcessEnv = {};

  for (const name of allowedNames) {
    if (source[name] !== undefined) {
      environment[name] = source[name];
    }
  }

  return environment;
}

export const executeProcess: ProcessExecutor = async (
  invocation,
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      env: invocation.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let capturedBytes = 0;
    let timedOut = false;
    let outputTruncated = false;
    let stopping = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const stopProcess = (): void => {
      if (stopping) return;
      stopping = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_DELAY_MS);
      forceKillTimer.unref();
    };

    const capture = (target: Buffer[], chunk: Buffer): void => {
      const remaining = invocation.maxOutputBytes - capturedBytes;
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining);
        target.push(retained);
        capturedBytes += retained.length;
      }

      // Keep draining the pipes so verbose Codex progress cannot block the child,
      // but bound retained untrusted diagnostics independently of the result file.
      if (chunk.length > remaining) outputTruncated = true;
    };

    child.stdout.on("data", (chunk: Buffer) => capture(stdoutChunks, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderrChunks, chunk));

    const timeout = setTimeout(() => {
      timedOut = true;
      stopProcess();
    }, invocation.timeoutMs);
    timeout.unref();

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      reject(error);
    });

    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
        outputTruncated,
      });
    });

    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && !settled) {
        settled = true;
        clearTimeout(timeout);
        if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
        child.kill("SIGKILL");
        reject(error);
      }
    });
    child.stdin.end(invocation.stdin);
  });

function validateOptions(options: CodexRunnerOptions): void {
  for (const [name, value] of [
    ["worktreePath", options.worktreePath],
    ["schemaPath", options.schemaPath],
    ["instructionsPath", options.instructionsPath],
    ["outputPath", options.outputPath],
  ] as const) {
    if (!path.isAbsolute(value)) {
      throw new TypeError(`${name} must be an absolute path`);
    }
  }

  if (!options.model || /\s/.test(options.model)) {
    throw new TypeError("model must be a non-empty identifier without whitespace");
  }
  if (!["none", "low", "medium", "high", "xhigh", "max"].includes(options.reasoningEffort)) {
    throw new TypeError("reasoningEffort is not supported");
  }

  if (!options.prompt.trim()) {
    throw new TypeError("prompt must not be empty");
  }

  for (const [name, value] of [
    ["timeoutMs", options.timeoutMs],
    ["maxProcessOutputBytes", options.maxProcessOutputBytes],
    ["maxReviewOutputBytes", options.maxReviewOutputBytes],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new TypeError(`${name} must be a positive integer`);
    }
  }
}

async function assertTrustedPaths(options: CodexRunnerOptions): Promise<void> {
  const worktree = await realpath(options.worktreePath);
  const schema = await realpath(options.schemaPath);
  const instructions = await realpath(options.instructionsPath);
  const outputParent = await realpath(path.dirname(options.outputPath));

  for (const [name, candidate] of [
    ["schemaPath", schema],
    ["instructionsPath", instructions],
    ["outputPath", path.join(outputParent, path.basename(options.outputPath))],
  ] as const) {
    if (isPathInside(worktree, candidate)) {
      throw new TypeError(`${name} must be outside the review worktree`);
    }
  }
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}
