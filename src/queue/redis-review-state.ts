import type { ReviewState, ReviewStateStore, ReviewStatus } from "./review-state.js";
import { reviewStateRedisKey } from "./review-state.js";

export interface RedisScriptClient {
  defineCommand(
    name: string,
    definition: { numberOfKeys: number; lua: string; readOnly?: boolean },
  ): void;
  runCommand(name: string, args: unknown[]): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  del(...keys: string[]): Promise<number>;
}

const REQUEST_COMMAND = "autoAgentRecordReviewRequest";
const START_COMMAND = "autoAgentTryStartReview";
const ENQUEUE_FAILED_COMMAND = "autoAgentReviewEnqueueFailed";
const CAN_PUBLISH_COMMAND = "autoAgentCanPublishReview";
const COMPLETE_COMMAND = "autoAgentCompleteReview";
const FAIL_COMMAND = "autoAgentFailReview";

export class RedisReviewStateStore implements ReviewStateStore {
  readonly #redis: RedisScriptClient;
  readonly #now: () => Date;

  constructor(redis: RedisScriptClient, now: () => Date = () => new Date()) {
    this.#redis = redis;
    this.#now = now;
    redis.defineCommand(REQUEST_COMMAND, { numberOfKeys: 1, lua: REQUEST_SCRIPT });
    redis.defineCommand(START_COMMAND, { numberOfKeys: 1, lua: START_SCRIPT });
    redis.defineCommand(ENQUEUE_FAILED_COMMAND, {
      numberOfKeys: 1,
      lua: ENQUEUE_FAILED_SCRIPT,
    });
    redis.defineCommand(CAN_PUBLISH_COMMAND, {
      numberOfKeys: 1,
      lua: CAN_PUBLISH_SCRIPT,
      readOnly: true,
    });
    redis.defineCommand(COMPLETE_COMMAND, { numberOfKeys: 1, lua: COMPLETE_SCRIPT });
    redis.defineCommand(FAIL_COMMAND, { numberOfKeys: 1, lua: FAIL_SCRIPT });
  }

  async recordRequested(repository: string, pullRequestNumber: number, headSha: string): Promise<boolean> {
    validate(repository, pullRequestNumber, headSha);
    return this.#booleanResult(
      REQUEST_COMMAND,
      repository,
      pullRequestNumber,
      headSha.toLowerCase(),
    );
  }

  async tryStart(repository: string, pullRequestNumber: number, headSha: string): Promise<boolean> {
    validate(repository, pullRequestNumber, headSha);
    return this.#booleanResult(START_COMMAND, repository, pullRequestNumber, headSha.toLowerCase());
  }

  async enqueueFailed(repository: string, pullRequestNumber: number, headSha: string): Promise<void> {
    validate(repository, pullRequestNumber, headSha);
    await this.#booleanResult(
      ENQUEUE_FAILED_COMMAND,
      repository,
      pullRequestNumber,
      headSha.toLowerCase(),
    );
  }

  async canPublish(repository: string, pullRequestNumber: number, headSha: string): Promise<boolean> {
    validate(repository, pullRequestNumber, headSha);
    return this.#booleanResult(
      CAN_PUBLISH_COMMAND,
      repository,
      pullRequestNumber,
      headSha.toLowerCase(),
    );
  }

  async complete(repository: string, pullRequestNumber: number, headSha: string): Promise<boolean> {
    validate(repository, pullRequestNumber, headSha);
    return this.#booleanResult(COMPLETE_COMMAND, repository, pullRequestNumber, headSha.toLowerCase());
  }

  async fail(repository: string, pullRequestNumber: number, headSha: string): Promise<void> {
    validate(repository, pullRequestNumber, headSha);
    await this.#booleanResult(FAIL_COMMAND, repository, pullRequestNumber, headSha.toLowerCase());
  }

  async get(repository: string, pullRequestNumber: number): Promise<ReviewState | null> {
    validate(repository, pullRequestNumber, "0".repeat(40));
    const values = await this.#redis.hgetall(reviewStateRedisKey(repository, pullRequestNumber));
    if (Object.keys(values).length === 0) return null;
    const status = values.status;
    if (!isReviewStatus(status)) throw new Error("Redis contains invalid review status");
    const storedNumber = Number.parseInt(values.pull_request_number ?? "", 10);
    if (!Number.isSafeInteger(storedNumber) || storedNumber < 1) {
      throw new Error("Redis contains invalid pull request number");
    }
    return {
      repository: requireStored(values.repository, "repository"),
      pullRequestNumber: storedNumber,
      latestRequestedHeadSha: requireSha(values.latest_requested_head_sha),
      currentlyRunningHeadSha: optionalSha(values.currently_running_head_sha),
      lastReviewedHeadSha: optionalSha(values.last_reviewed_head_sha),
      status,
      updatedAt: requireStored(values.updated_at, "updated_at"),
    };
  }

  async #booleanResult(
    command: string,
    repository: string,
    pullRequestNumber: number,
    headSha: string,
  ): Promise<boolean> {
    const result = await this.#redis.runCommand(command, [
      reviewStateRedisKey(repository, pullRequestNumber),
      repository,
      String(pullRequestNumber),
      headSha,
      this.#now().toISOString(),
    ]);
    if (result !== 0 && result !== 1 && result !== "0" && result !== "1") {
      throw new Error("Redis review state command returned an invalid result");
    }
    return result === 1 || result === "1";
  }
}

const REQUEST_SCRIPT = `
local latest = redis.call('HGET', KEYS[1], 'latest_requested_head_sha')
local status = redis.call('HGET', KEYS[1], 'status')
if latest == ARGV[3] and status ~= 'failed' then return 0 end
local running = redis.call('HGET', KEYS[1], 'currently_running_head_sha')
local next_status = 'queued'
if running and running ~= '' then next_status = 'running' end
redis.call('HSET', KEYS[1],
  'repository', ARGV[1],
  'pull_request_number', ARGV[2],
  'latest_requested_head_sha', ARGV[3],
  'status', next_status,
  'updated_at', ARGV[4])
return 1`;

const START_SCRIPT = `
local latest = redis.call('HGET', KEYS[1], 'latest_requested_head_sha')
if latest ~= ARGV[3] then return 0 end
local reviewed = redis.call('HGET', KEYS[1], 'last_reviewed_head_sha')
local status = redis.call('HGET', KEYS[1], 'status')
if reviewed == ARGV[3] and status == 'reviewed' then return 0 end
local running = redis.call('HGET', KEYS[1], 'currently_running_head_sha')
if running and running ~= '' and running ~= ARGV[3] then return 0 end
redis.call('HSET', KEYS[1],
  'currently_running_head_sha', ARGV[3],
  'status', 'running',
  'updated_at', ARGV[4])
return 1`;

const ENQUEUE_FAILED_SCRIPT = `
local latest = redis.call('HGET', KEYS[1], 'latest_requested_head_sha')
if latest ~= ARGV[3] then return 0 end
local running = redis.call('HGET', KEYS[1], 'currently_running_head_sha')
if running and running ~= '' and running ~= ARGV[3] then
  redis.call('HSET', KEYS[1],
    'latest_requested_head_sha', running,
    'status', 'running',
    'updated_at', ARGV[4])
  return 1
end
redis.call('HSET', KEYS[1], 'status', 'failed', 'updated_at', ARGV[4])
return 1`;

const CAN_PUBLISH_SCRIPT = `
local latest = redis.call('HGET', KEYS[1], 'latest_requested_head_sha')
local running = redis.call('HGET', KEYS[1], 'currently_running_head_sha')
local status = redis.call('HGET', KEYS[1], 'status')
if latest == ARGV[3] and running == ARGV[3] and status == 'running' then return 1 end
return 0`;

const COMPLETE_SCRIPT = `
local latest = redis.call('HGET', KEYS[1], 'latest_requested_head_sha')
local running = redis.call('HGET', KEYS[1], 'currently_running_head_sha')
if latest == ARGV[3] and running == ARGV[3] then
  redis.call('HDEL', KEYS[1], 'currently_running_head_sha')
  redis.call('HSET', KEYS[1],
    'last_reviewed_head_sha', ARGV[3],
    'status', 'reviewed',
    'updated_at', ARGV[4])
  return 1
end
if running == ARGV[3] then
  redis.call('HDEL', KEYS[1], 'currently_running_head_sha')
  redis.call('HSET', KEYS[1], 'status', 'queued', 'updated_at', ARGV[4])
end
return 0`;

const FAIL_SCRIPT = `
local latest = redis.call('HGET', KEYS[1], 'latest_requested_head_sha')
local running = redis.call('HGET', KEYS[1], 'currently_running_head_sha')
local status = redis.call('HGET', KEYS[1], 'status')
if (not running or running == '') and latest == ARGV[3] and status == 'queued' then
  redis.call('HSET', KEYS[1], 'status', 'failed', 'updated_at', ARGV[4])
  return 1
end
if running ~= ARGV[3] then return 0 end
redis.call('HDEL', KEYS[1], 'currently_running_head_sha')
local next_status = 'queued'
if latest == ARGV[3] then next_status = 'failed' end
redis.call('HSET', KEYS[1], 'status', next_status, 'updated_at', ARGV[4])
return 1`;

function validate(repository: string, pullRequestNumber: number, headSha: string): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(repository)) {
    throw new TypeError("repository must use owner/name format");
  }
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
    throw new TypeError("pullRequestNumber must be a positive integer");
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(headSha)) {
    throw new TypeError("headSha must be a full Git object ID");
  }
}

function isReviewStatus(value: string | undefined): value is ReviewStatus {
  return value === "queued" || value === "running" || value === "reviewed" || value === "failed";
}

function requireStored(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new Error(`Redis contains invalid ${name}`);
  return value;
}

function requireSha(value: string | undefined): string {
  const sha = requireStored(value, "SHA");
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) throw new Error("Redis contains invalid SHA");
  return sha;
}

function optionalSha(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : requireSha(value);
}
