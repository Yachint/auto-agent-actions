import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ReasoningEffort } from "../codex/runner.js";

export interface WebhookServerConfig {
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly redisUrl: string;
  readonly reviewQueueName: string;
  readonly publicationQueueName: string;
  readonly reviewQueueDebounceMs: number;
  readonly webhookSecret: string;
  readonly allowedRepositories: ReadonlySet<string>;
}

interface QueueRuntimeConfig {
  readonly logLevel: string;
  readonly redisUrl: string;
  readonly reviewQueueName: string;
  readonly publicationQueueName: string;
  readonly allowedRepositories: ReadonlySet<string>;
}

export interface AnalysisWorkerConfig extends QueueRuntimeConfig {
  readonly concurrency: number;
  readonly brokerSocketPath: string;
  readonly brokerSharedSecret: string;
  readonly dataDirectory: string;
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly timeoutMs: number;
  readonly codexBinary: string;
  readonly schemaPath: string;
  readonly instructionsPath: string;
  readonly abandonedWorktreeAgeMs: number;
}

export interface PublisherWorkerConfig extends QueueRuntimeConfig {
  readonly concurrency: number;
  readonly appId: string;
  readonly privateKey: string;
  readonly brokerSocketPath: string;
  readonly brokerSharedSecret: string;
  readonly minimumConfidence: number;
  readonly maximumInlineComments: number;
  readonly publishSummaryWithoutFindings: boolean;
  readonly reconciliationIntervalMs: number;
}

export async function loadWebhookServerConfig(
  source: NodeJS.ProcessEnv = process.env,
): Promise<WebhookServerConfig> {
  return {
    host: source.HOST ?? "127.0.0.1",
    port: positiveInteger(source.PORT ?? "3000", "PORT", 65_535),
    logLevel: parseLogLevel(source.LOG_LEVEL ?? "info"),
    redisUrl: parseRedisUrl(required(source.REDIS_URL, "REDIS_URL")),
    reviewQueueName: queueName(source.REVIEW_QUEUE_NAME ?? "pull-request-reviews", "REVIEW_QUEUE_NAME"),
    publicationQueueName: queueName(
      source.PUBLICATION_QUEUE_NAME ?? "pull-request-publications",
      "PUBLICATION_QUEUE_NAME",
    ),
    reviewQueueDebounceMs: positiveInteger(
      source.REVIEW_QUEUE_DEBOUNCE_MS ?? "1000",
      "REVIEW_QUEUE_DEBOUNCE_MS",
      60_000,
    ),
    webhookSecret: await loadSecret(
      source.GITHUB_WEBHOOK_SECRET,
      source.GITHUB_WEBHOOK_SECRET_FILE,
      "GITHUB_WEBHOOK_SECRET",
    ),
    allowedRepositories: parseAllowedRepositories(
      required(source.GITHUB_ALLOWED_REPOSITORIES, "GITHUB_ALLOWED_REPOSITORIES"),
    ),
  };
}

export async function loadAnalysisWorkerConfig(
  source: NodeJS.ProcessEnv = process.env,
): Promise<AnalysisWorkerConfig> {
  const common = await loadQueueRuntimeConfig(source);
  return {
    ...common,
    concurrency: positiveInteger(source.REVIEW_WORKER_CONCURRENCY ?? "1", "REVIEW_WORKER_CONCURRENCY", 32),
    brokerSocketPath: absolutePath(
      required(source.READ_TOKEN_BROKER_SOCKET, "READ_TOKEN_BROKER_SOCKET"),
      "READ_TOKEN_BROKER_SOCKET",
    ),
    brokerSharedSecret: await loadSecret(
      source.READ_TOKEN_BROKER_SECRET,
      source.READ_TOKEN_BROKER_SECRET_FILE,
      "READ_TOKEN_BROKER_SECRET",
    ),
    dataDirectory: path.resolve(source.REVIEW_DATA_DIR ?? ".review-data"),
    model: modelIdentifier(source.CODEX_MODEL ?? "gpt-5.6-sol"),
    reasoningEffort: reasoningEffort(source.CODEX_REASONING_EFFORT ?? "high"),
    timeoutMs: positiveInteger(source.CODEX_TIMEOUT_MS ?? "600000", "CODEX_TIMEOUT_MS", 3_600_000),
    codexBinary: commandName(source.CODEX_BINARY ?? "codex", "CODEX_BINARY"),
    schemaPath: fileURLToPath(new URL("../codex/review-schema.json", import.meta.url)),
    instructionsPath: fileURLToPath(new URL("../codex/review-instructions.md", import.meta.url)),
    abandonedWorktreeAgeMs: positiveInteger(
      source.ABANDONED_WORKTREE_AGE_MS ?? "86400000",
      "ABANDONED_WORKTREE_AGE_MS",
      30 * 24 * 60 * 60 * 1_000,
    ),
  };
}

export async function loadPublisherWorkerConfig(
  source: NodeJS.ProcessEnv = process.env,
): Promise<PublisherWorkerConfig> {
  const common = await loadQueueRuntimeConfig(source);
  const privateKeyPath = absolutePath(
    required(source.GITHUB_APP_PRIVATE_KEY_FILE, "GITHUB_APP_PRIVATE_KEY_FILE"),
    "GITHUB_APP_PRIVATE_KEY_FILE",
  );
  const appId = required(source.GITHUB_APP_ID, "GITHUB_APP_ID");
  if (!/^\d+$/.test(appId) || appId === "0") {
    throw new TypeError("GITHUB_APP_ID must be a positive integer");
  }
  return {
    ...common,
    concurrency: positiveInteger(
      source.PUBLISHER_WORKER_CONCURRENCY ?? "5",
      "PUBLISHER_WORKER_CONCURRENCY",
      32,
    ),
    appId,
    privateKey: await readFile(privateKeyPath, "utf8"),
    brokerSocketPath: absolutePath(
      required(source.READ_TOKEN_BROKER_SOCKET, "READ_TOKEN_BROKER_SOCKET"),
      "READ_TOKEN_BROKER_SOCKET",
    ),
    brokerSharedSecret: await loadSecret(
      source.READ_TOKEN_BROKER_SECRET,
      source.READ_TOKEN_BROKER_SECRET_FILE,
      "READ_TOKEN_BROKER_SECRET",
    ),
    minimumConfidence: boundedNumber(
      source.REVIEW_MINIMUM_CONFIDENCE ?? "0.8",
      "REVIEW_MINIMUM_CONFIDENCE",
      0,
      1,
    ),
    maximumInlineComments: positiveInteger(
      source.REVIEW_MAXIMUM_INLINE_COMMENTS ?? "20",
      "REVIEW_MAXIMUM_INLINE_COMMENTS",
      100,
    ),
    publishSummaryWithoutFindings: strictBoolean(
      source.REVIEW_PUBLISH_SUMMARY_WITHOUT_FINDINGS ?? "true",
      "REVIEW_PUBLISH_SUMMARY_WITHOUT_FINDINGS",
    ),
    reconciliationIntervalMs: positiveInteger(
      source.RECONCILIATION_INTERVAL_MS ?? "900000",
      "RECONCILIATION_INTERVAL_MS",
      86_400_000,
    ),
  };
}

async function loadQueueRuntimeConfig(source: NodeJS.ProcessEnv): Promise<QueueRuntimeConfig> {
  return {
    logLevel: parseLogLevel(source.LOG_LEVEL ?? "info"),
    redisUrl: parseRedisUrl(required(source.REDIS_URL, "REDIS_URL")),
    reviewQueueName: queueName(source.REVIEW_QUEUE_NAME ?? "pull-request-reviews", "REVIEW_QUEUE_NAME"),
    publicationQueueName: queueName(
      source.PUBLICATION_QUEUE_NAME ?? "pull-request-publications",
      "PUBLICATION_QUEUE_NAME",
    ),
    allowedRepositories: parseAllowedRepositories(
      required(source.GITHUB_ALLOWED_REPOSITORIES, "GITHUB_ALLOWED_REPOSITORIES"),
    ),
  };
}

async function loadSecret(
  inlineValue: string | undefined,
  filePath: string | undefined,
  name: string,
): Promise<string> {
  if (inlineValue !== undefined && filePath !== undefined) {
    throw new TypeError(`${name} and ${name}_FILE are mutually exclusive`);
  }
  let value = inlineValue;
  if (filePath !== undefined) {
    if (!filePath.startsWith("/") || filePath.includes("\0")) {
      throw new TypeError(`${name}_FILE must be an absolute path`);
    }
    value = (await readFile(filePath, "utf8")).trimEnd();
  }
  if (value === undefined || value.length < 32 || /[\0\r\n]/.test(value)) {
    throw new TypeError(`${name} must be a single-line secret of at least 32 characters`);
  }
  return value;
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new TypeError(`${name} is required`);
  return value;
}

function positiveInteger(value: string, name: string, maximum: number): number {
  if (!/^\d+$/.test(value)) throw new TypeError(`${name} must be a positive integer`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new TypeError(`${name} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function boundedNumber(
  value: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function strictBoolean(value: string, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new TypeError(`${name} must be true or false`);
}

function parseRedisUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("REDIS_URL must be a valid redis:// or rediss:// URL");
  }
  if (
    (url.protocol !== "redis:" && url.protocol !== "rediss:") ||
    url.hostname.length === 0 ||
    url.hash.length > 0
  ) {
    throw new TypeError("REDIS_URL must be a valid redis:// or rediss:// URL");
  }
  return value;
}

function queueName(value: string, name: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(value)) {
    throw new TypeError(`${name} must be a safe queue identifier`);
  }
  return value;
}

function parseLogLevel(value: string): string {
  if (!new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).has(value)) {
    throw new TypeError("LOG_LEVEL is invalid");
  }
  return value;
}

function parseAllowedRepositories(value: string): ReadonlySet<string> {
  const repositories = value.split(",").map((repository) => repository.trim());
  if (
    repositories.length === 0 ||
    repositories.some(
      (repository) =>
        !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(repository),
    )
  ) {
    throw new TypeError("GITHUB_ALLOWED_REPOSITORIES must be a comma-separated owner/name list");
  }
  if (new Set(repositories).size !== repositories.length) {
    throw new TypeError("GITHUB_ALLOWED_REPOSITORIES must not contain duplicates");
  }
  return new Set(repositories);
}

function absolutePath(value: string, name: string): string {
  if (!path.isAbsolute(value) || value.includes("\0")) {
    throw new TypeError(`${name} must be an absolute path`);
  }
  return value;
}

function modelIdentifier(value: string): string {
  if (!value || /\s/.test(value)) throw new TypeError("CODEX_MODEL is invalid");
  return value;
}

function commandName(value: string, name: string): string {
  if (!value || value.includes("\0") || /[\r\n]/.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function reasoningEffort(value: string): ReasoningEffort {
  if (!new Set(["none", "low", "medium", "high", "xhigh", "max"]).has(value)) {
    throw new TypeError("CODEX_REASONING_EFFORT is invalid");
  }
  return value as ReasoningEffort;
}
