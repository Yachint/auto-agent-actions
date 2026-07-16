import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runLocalReview } from "../workflows/local-review.js";
import type { ReasoningEffort } from "../codex/runner.js";

const MAX_FIXTURE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MODEL = "gpt-5.6-sol";
const DEFAULT_REASONING_EFFORT: ReasoningEffort = "high";

interface CliOptions {
  fixturePath: string;
  dataDirectory: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  timeoutMs: number;
  remoteUrlOverride?: string;
  codexBinary?: string;
}

export async function main(
  args: string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const options = parseArguments(args, environment, cwd);
  const fixtureBuffer = await readFile(options.fixturePath);
  if (fixtureBuffer.length > MAX_FIXTURE_BYTES) {
    throw new TypeError(`fixture exceeds ${MAX_FIXTURE_BYTES} bytes`);
  }

  let fixture: unknown;
  try {
    fixture = JSON.parse(fixtureBuffer.toString("utf8"));
  } catch {
    throw new TypeError("fixture must contain valid JSON");
  }

  const result = await runLocalReview({
    fixture,
    dataDirectory: options.dataDirectory,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    timeoutMs: options.timeoutMs,
    schemaPath: fileURLToPath(
      new URL("../codex/review-schema.json", import.meta.url),
    ),
    instructionsPath: fileURLToPath(
      new URL("../codex/review-instructions.md", import.meta.url),
    ),
    environment,
    ...(options.remoteUrlOverride === undefined
      ? {}
      : { remoteUrlOverride: options.remoteUrlOverride }),
    ...(options.codexBinary === undefined
      ? {}
      : { codexBinary: options.codexBinary }),
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

function parseArguments(
  args: string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
): CliOptions {
  let fixturePath: string | undefined;
  let remoteUrlOverride: string | undefined;
  let dataDirectory = path.resolve(
    cwd,
    environment.REVIEW_DATA_DIR ?? ".review-data",
  );
  let model = environment.CODEX_MODEL ?? DEFAULT_MODEL;
  let reasoningEffort = parseReasoningEffort(
    environment.CODEX_REASONING_EFFORT ?? DEFAULT_REASONING_EFFORT,
  );
  let timeoutMs = parsePositiveInteger(
    environment.CODEX_TIMEOUT_MS,
    "CODEX_TIMEOUT_MS",
    DEFAULT_TIMEOUT_MS,
  );

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--remote") {
      remoteUrlOverride = requireOptionValue(args, ++index, "--remote");
      continue;
    }
    if (argument === "--data-dir") {
      dataDirectory = path.resolve(
        cwd,
        requireOptionValue(args, ++index, "--data-dir"),
      );
      continue;
    }
    if (argument === "--model") {
      model = requireOptionValue(args, ++index, "--model");
      continue;
    }
    if (argument === "--timeout-ms") {
      timeoutMs = parsePositiveInteger(
        requireOptionValue(args, ++index, "--timeout-ms"),
        "--timeout-ms",
      );
      continue;
    }
    if (argument === "--reasoning-effort") {
      reasoningEffort = parseReasoningEffort(
        requireOptionValue(args, ++index, "--reasoning-effort"),
      );
      continue;
    }
    if (argument?.startsWith("-")) {
      throw new TypeError(`unknown option ${argument}\n\n${usage()}`);
    }
    if (fixturePath !== undefined) {
      throw new TypeError(`only one fixture path is allowed\n\n${usage()}`);
    }
    fixturePath = argument;
  }

  if (fixturePath === undefined) {
    throw new TypeError(`fixture path is required\n\n${usage()}`);
  }
  return {
    fixturePath: path.resolve(cwd, fixturePath),
    dataDirectory,
    model,
    reasoningEffort,
    timeoutMs,
    ...(remoteUrlOverride === undefined
      ? {}
      : { remoteUrlOverride: resolveRemote(remoteUrlOverride, cwd) }),
    ...(environment.CODEX_BINARY === undefined
      ? {}
      : { codexBinary: environment.CODEX_BINARY }),
  };
}

function requireOptionValue(
  args: string[],
  index: number,
  option: string,
): string {
  const value = args[index];
  if (!value || value.startsWith("-")) {
    throw new TypeError(`${option} requires a value`);
  }
  return value;
}

function parsePositiveInteger(
  value: string | undefined,
  name: string,
  fallback?: number,
): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return parsed;
}

function resolveRemote(value: string, cwd: string): string {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
    ? value
    : path.resolve(cwd, value);
}

function parseReasoningEffort(value: string): ReasoningEffort {
  if (!["none", "low", "medium", "high", "xhigh", "max"].includes(value)) {
    throw new TypeError(
      "reasoning effort must be one of none, low, medium, high, xhigh, or max",
    );
  }
  return value as ReasoningEffort;
}

function usage(): string {
  return `Usage: npm run review:fixture -- <fixture.json> [options]

Options:
  --remote <url-or-path>  Override repository.clone_url (useful for local repos)
  --data-dir <path>       Review data directory (default: .review-data)
  --model <model>         Codex model (default: ${DEFAULT_MODEL})
  --reasoning-effort <n>  Reasoning effort (default: ${DEFAULT_REASONING_EFFORT})
  --timeout-ms <ms>       Codex timeout (default: ${DEFAULT_TIMEOUT_MS})`;
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(entryPoint)).href
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown failure";
    process.stderr.write(`Local review failed: ${message}\n`);
    process.exitCode = 1;
  });
}
