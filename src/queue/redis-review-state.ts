import type {
  ReviewState,
  ReviewStateStore,
  ReviewStatus,
} from "./review-state.js";
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

const RECEIPT_COMMAND = "autoAgentRecordPublicationReceipt";
const RECOVER_COMMAND = "autoAgentRecoverExpiredReview";
const RENEW_COMMAND = "autoAgentRenewReview";
const HANDOFF_COMMAND = "autoAgentHandoffReview";

const REQUEST_COMMAND = "autoAgentRecordReviewRequest";
const START_COMMAND = "autoAgentTryStartReview";
const ENQUEUE_FAILED_COMMAND = "autoAgentReviewEnqueueFailed";
const CAN_PUBLISH_COMMAND = "autoAgentCanPublishReview";
const COMPLETE_COMMAND = "autoAgentCompleteReview";
const FAIL_COMMAND = "autoAgentFailReview";
const EXHAUST_COMMAND = "autoAgentExhaustAnalysis";

export class RedisReviewStateStore implements ReviewStateStore {
  readonly #redis: RedisScriptClient;
  readonly #now: () => Date;

  constructor(redis: RedisScriptClient, now: () => Date = () => new Date()) {
    this.#redis = redis;
    this.#now = now;
    redis.defineCommand(RECEIPT_COMMAND, {
      numberOfKeys: 1,
      lua: RECEIPT_SCRIPT,
    });
    redis.defineCommand(RECOVER_COMMAND, {
      numberOfKeys: 1,
      lua: RECOVER_SCRIPT,
    });
    redis.defineCommand(RENEW_COMMAND, { numberOfKeys: 1, lua: RENEW_SCRIPT });
    redis.defineCommand(HANDOFF_COMMAND, {
      numberOfKeys: 1,
      lua: HANDOFF_SCRIPT,
    });
    redis.defineCommand(REQUEST_COMMAND, {
      numberOfKeys: 1,
      lua: REQUEST_SCRIPT,
    });
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
    redis.defineCommand(COMPLETE_COMMAND, {
      numberOfKeys: 1,
      lua: COMPLETE_SCRIPT,
    });
    redis.defineCommand(FAIL_COMMAND, { numberOfKeys: 1, lua: FAIL_SCRIPT });
    redis.defineCommand(EXHAUST_COMMAND, { numberOfKeys: 1, lua: EXHAUST_SCRIPT });
  }

  async exhaustAnalysis(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    attemptId?: string,
  ): Promise<boolean> {
    validate(repository, pullRequestNumber, headSha);
    return this.#booleanResult(
      EXHAUST_COMMAND, repository, pullRequestNumber,
      headSha.toLowerCase(), attemptId,
    );
  }

  async recordRequested(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    attemptId?: string,
    schedulingRequest?: string,
  ): Promise<boolean> {
    validate(repository, pullRequestNumber, headSha);
    return this.#booleanResult(
      REQUEST_COMMAND,
      repository,
      pullRequestNumber,
      headSha.toLowerCase(),
      attemptId,
      schedulingRequest,
    );
  }

  async tryStart(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    attemptId?: string,
  ): Promise<boolean> {
    validate(repository, pullRequestNumber, headSha);
    return this.#booleanResult(
      START_COMMAND,
      repository,
      pullRequestNumber,
      headSha.toLowerCase(),
      attemptId,
    );
  }

  async recordReceipt(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    reviewId: number,
  ): Promise<void> {
    validate(repository, pullRequestNumber, headSha);
    if (!Number.isSafeInteger(reviewId) || reviewId < 1)
      throw new TypeError("invalid review receipt");
    await this.#booleanResult(
      RECEIPT_COMMAND,
      repository,
      pullRequestNumber,
      headSha.toLowerCase(),
      undefined,
      String(reviewId),
    );
  }

  async recoverExpired(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    cutoff: string,
  ): Promise<boolean> {
    validate(repository, pullRequestNumber, headSha);
    if (!Number.isFinite(Date.parse(cutoff)))
      throw new TypeError("invalid lease cutoff");
    return this.#booleanResult(
      RECOVER_COMMAND,
      repository,
      pullRequestNumber,
      headSha.toLowerCase(),
      undefined,
      cutoff,
    );
  }

  async renew(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    attemptId: string,
  ): Promise<boolean> {
    validate(repository, pullRequestNumber, headSha);
    return this.#booleanResult(
      RENEW_COMMAND,
      repository,
      pullRequestNumber,
      headSha.toLowerCase(),
      attemptId,
    );
  }

  async handoff(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    artifact: string,
    attemptId?: string,
  ): Promise<boolean> {
    validate(repository, pullRequestNumber, headSha);
    const result = await this.#redis.runCommand(HANDOFF_COMMAND, [
      reviewStateRedisKey(repository, pullRequestNumber),
      headSha.toLowerCase(),
      artifact,
      this.#now().toISOString(),
      attemptId ?? "",
    ]);
    return result === 1 || result === "1";
  }

  async enqueueFailed(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    attemptId?: string,
  ): Promise<void> {
    validate(repository, pullRequestNumber, headSha);
    await this.#booleanResult(
      ENQUEUE_FAILED_COMMAND,
      repository,
      pullRequestNumber,
      headSha.toLowerCase(),
      attemptId,
    );
  }

  async canPublish(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    attemptId?: string,
  ): Promise<boolean> {
    validate(repository, pullRequestNumber, headSha);
    return this.#booleanResult(
      CAN_PUBLISH_COMMAND,
      repository,
      pullRequestNumber,
      headSha.toLowerCase(),
      attemptId,
    );
  }

  async complete(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    attemptId?: string,
  ): Promise<boolean> {
    validate(repository, pullRequestNumber, headSha);
    return this.#booleanResult(
      COMPLETE_COMMAND,
      repository,
      pullRequestNumber,
      headSha.toLowerCase(),
      attemptId,
    );
  }

  async fail(
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    attemptId?: string,
  ): Promise<void> {
    validate(repository, pullRequestNumber, headSha);
    await this.#booleanResult(
      FAIL_COMMAND,
      repository,
      pullRequestNumber,
      headSha.toLowerCase(),
      attemptId,
    );
  }

  async get(
    repository: string,
    pullRequestNumber: number,
  ): Promise<ReviewState | null> {
    validate(repository, pullRequestNumber, "0".repeat(40));
    const values = await this.#redis.hgetall(
      reviewStateRedisKey(repository, pullRequestNumber),
    );
    if (Object.keys(values).length === 0) return null;
    const status = values.status;
    if (!isReviewStatus(status))
      throw new Error("Redis contains invalid review status");
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
      ...(values.last_review_id === undefined
        ? {}
        : {
            lastPublication: {
              scopeSha: requireSha(values.last_publication_scope),
              reviewId: requireReviewId(values.last_review_id),
            },
          }),
      ...(values.scheduling_request
        ? { schedulingRequest: values.scheduling_request }
        : {}),
      ...(values.analysis_exhausted_scope
        ? { analysisExhaustedScope: requireSha(values.analysis_exhausted_scope) }
        : {}),
      ...(values.attempt_id ? { attemptId: values.attempt_id } : {}),
      ...(values.publication_artifact
        ? { publicationArtifact: values.publication_artifact }
        : {}),
    };
  }

  async #booleanResult(
    command: string,
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    attemptId?: string,
    schedulingRequest?: string,
  ): Promise<boolean> {
    const result = await this.#redis.runCommand(command, [
      reviewStateRedisKey(repository, pullRequestNumber),
      repository,
      String(pullRequestNumber),
      headSha,
      this.#now().toISOString(),
      attemptId ?? "",
      schedulingRequest ?? "",
    ]);
    if (result !== 0 && result !== 1 && result !== "0" && result !== "1") {
      throw new Error("Redis review state command returned an invalid result");
    }
    return result === 1 || result === "1";
  }
}

const REQUEST_SCRIPT = `
if redis.call('HGET', KEYS[1], 'analysis_exhausted_scope') == ARGV[3] then return 0 end
local latest = redis.call('HGET', KEYS[1], 'latest_requested_head_sha')
local status = redis.call('HGET', KEYS[1], 'status')
if latest == ARGV[3] and status ~= 'failed' then return 0 end
local running = redis.call('HGET', KEYS[1], 'currently_running_head_sha')
local next_status = 'queued'
redis.call('HDEL', KEYS[1], 'currently_running_head_sha', 'publication_artifact', 'attempt_id')
redis.call('HSET', KEYS[1],
  'repository', ARGV[1],
  'pull_request_number', ARGV[2],
  'scheduling_request', ARGV[6],
  'latest_requested_head_sha', ARGV[3],
  'status', next_status,
  'updated_at', ARGV[4])
return 1`;

const START_SCRIPT = `
if redis.call('HGET', KEYS[1], 'analysis_exhausted_scope') == ARGV[3] then return 0 end
local latest = redis.call('HGET', KEYS[1], 'latest_requested_head_sha')
if latest ~= ARGV[3] then return 0 end
local reviewed = redis.call('HGET', KEYS[1], 'last_reviewed_head_sha')
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'publishing' or (reviewed == ARGV[3] and status == 'reviewed') then return 0 end
local running = redis.call('HGET', KEYS[1], 'currently_running_head_sha')
if running and running ~= '' then return 0 end
redis.call('HSET', KEYS[1],
  'attempt_id', ARGV[5],
  'currently_running_head_sha', ARGV[3],
  'status', 'running',
  'updated_at', ARGV[4])
return 1`;

const EXHAUST_SCRIPT = `
if redis.call('HGET', KEYS[1], 'latest_requested_head_sha') ~= ARGV[3] then return 0 end
if ARGV[5] ~= '' and redis.call('HGET', KEYS[1], 'attempt_id') ~= ARGV[5] then return 0 end
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'reviewed' or status == 'publishing' then return 0 end
redis.call('HSET', KEYS[1], 'analysis_exhausted_scope', ARGV[3], 'status', 'failed', 'updated_at', ARGV[4])
redis.call('HDEL', KEYS[1], 'currently_running_head_sha')
return 1`;

const ENQUEUE_FAILED_SCRIPT = `
if redis.call('HGET', KEYS[1], 'status') ~= 'queued' then return 0 end
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
if ARGV[5] ~= '' and redis.call('HGET', KEYS[1], 'attempt_id') ~= ARGV[5] then return 0 end
local latest = redis.call('HGET', KEYS[1], 'latest_requested_head_sha')
local running = redis.call('HGET', KEYS[1], 'currently_running_head_sha')
local status = redis.call('HGET', KEYS[1], 'status')
if latest == ARGV[3] and ((running == ARGV[3] and status == 'running') or status == 'publishing') then return 1 end
return 0`;

const COMPLETE_SCRIPT = `
if ARGV[5] ~= '' and redis.call('HGET', KEYS[1], 'attempt_id') ~= ARGV[5] then return 0 end
local latest = redis.call('HGET', KEYS[1], 'latest_requested_head_sha')
local running = redis.call('HGET', KEYS[1], 'currently_running_head_sha')
local status = redis.call('HGET', KEYS[1], 'status')
if latest == ARGV[3] and (running == ARGV[3] or status == 'publishing') then
  redis.call('HDEL', KEYS[1], 'currently_running_head_sha', 'publication_artifact', 'attempt_id')
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
if ARGV[5] ~= '' and redis.call('HGET', KEYS[1], 'attempt_id') ~= ARGV[5] then return 0 end
local latest = redis.call('HGET', KEYS[1], 'latest_requested_head_sha')
local running = redis.call('HGET', KEYS[1], 'currently_running_head_sha')
local status = redis.call('HGET', KEYS[1], 'status')
if (not running or running == '') and latest == ARGV[3] and status == 'queued' then
  redis.call('HSET', KEYS[1], 'status', 'failed', 'updated_at', ARGV[4])
  return 1
end
if running ~= ARGV[3] and not (latest == ARGV[3] and status == 'publishing') then return 0 end
redis.call('HDEL', KEYS[1], 'currently_running_head_sha')
local next_status = 'queued'
if latest == ARGV[3] then next_status = 'failed' end
redis.call('HSET', KEYS[1], 'status', next_status, 'updated_at', ARGV[4])
return 1`;

function validate(
  repository: string,
  pullRequestNumber: number,
  headSha: string,
): void {
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(
      repository,
    )
  ) {
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
  return (
    value === "publishing" ||
    value === "queued" ||
    value === "running" ||
    value === "reviewed" ||
    value === "failed"
  );
}

function requireStored(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0)
    throw new Error(`Redis contains invalid ${name}`);
  return value;
}

function requireSha(value: string | undefined): string {
  const sha = requireStored(value, "SHA");
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha))
    throw new Error("Redis contains invalid SHA");
  return sha;
}

function optionalSha(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : requireSha(value);
}

const HANDOFF_SCRIPT = `
if ARGV[4] ~= '' and redis.call('HGET', KEYS[1], 'attempt_id') ~= ARGV[4] then return 0 end
if redis.call('HGET', KEYS[1], 'latest_requested_head_sha') ~= ARGV[1] or redis.call('HGET', KEYS[1], 'currently_running_head_sha') ~= ARGV[1] then return 0 end
redis.call('HDEL', KEYS[1], 'currently_running_head_sha')
redis.call('HSET', KEYS[1], 'status', 'publishing', 'publication_artifact', ARGV[2], 'updated_at', ARGV[3])
return 1`;

const RENEW_SCRIPT = `
if redis.call('HGET', KEYS[1], 'latest_requested_head_sha') ~= ARGV[3] or redis.call('HGET', KEYS[1], 'attempt_id') ~= ARGV[5] or redis.call('HGET', KEYS[1], 'status') ~= 'running' then return 0 end
redis.call('HSET', KEYS[1], 'updated_at', ARGV[4])
return 1`;

const RECOVER_SCRIPT = `
if redis.call('HGET', KEYS[1], 'latest_requested_head_sha') ~= ARGV[3] or redis.call('HGET', KEYS[1], 'status') ~= 'running' then return 0 end
local updated = redis.call('HGET', KEYS[1], 'updated_at')
if not updated or updated > ARGV[6] then return 0 end
redis.call('HDEL', KEYS[1], 'currently_running_head_sha', 'attempt_id')
redis.call('HSET', KEYS[1], 'status', 'failed', 'updated_at', ARGV[4])
return 1`;

function requireReviewId(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error("Redis contains invalid review receipt");
  return Number(value);
}
const RECEIPT_SCRIPT = `
if redis.call('HGET', KEYS[1], 'latest_requested_head_sha') ~= ARGV[3] then return 0 end
redis.call('HSET', KEYS[1], 'last_publication_scope', ARGV[3], 'last_review_id', ARGV[6], 'updated_at', ARGV[4])
return 1`;
