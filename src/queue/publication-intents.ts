import { createHash } from "node:crypto";
import type { Redis } from "ioredis";

/** Publisher-owned metadata only; survives analysis scope replacement. */
export interface PublicationIntent {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly installationId: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly baseBranch?: string;
  readonly scopeSha: string;
  readonly marker: string;
}
export interface PendingPublicationIntent extends PublicationIntent {
  readonly id: string;
  readonly createdAt: number;
  readonly reviewId?: number;
}
export interface PublicationIntentStore {
  prepare(intent: PublicationIntent): Promise<string>;
  recordReviewId(id: string, reviewId: number): Promise<void>;
  list(limit: number): Promise<readonly PendingPublicationIntent[]>;
  touch(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}
export function publicationIntentId(intent: PublicationIntent): string {
  validateIntent(intent);
  return createHash("sha256")
    .update(
      `${intent.repository}#${intent.pullRequestNumber}#${intent.scopeSha}#${intent.marker}`,
    )
    .digest("hex");
}
function validateIntent(value: PublicationIntent): void {
  if (
    !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(value.repository) ||
    !Number.isSafeInteger(value.pullRequestNumber) ||
    value.pullRequestNumber < 1 ||
    !Number.isSafeInteger(value.installationId) ||
    value.installationId < 1 ||
    [value.headSha, value.baseSha, value.scopeSha].some(
      (sha) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha),
    ) ||
    !/^<!-- auto-agent-actions:review=[a-f0-9]{64} -->$/.test(value.marker) ||
    (value.baseBranch !== undefined &&
      (!value.baseBranch ||
        value.baseBranch.length > 255 ||
        /[\0\r\n]/.test(value.baseBranch)))
  )
    throw new TypeError("invalid publisher intent");
}
export class RedisPublicationIntentStore implements PublicationIntentStore {
  constructor(
    readonly redis: Redis,
    readonly prefix = "auto-agent-actions:publisher-intents",
  ) {}
  #key(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new TypeError("invalid publication intent identity");
    return `${this.prefix}:${id}`;
  }
  async prepare(intent: PublicationIntent): Promise<string> {
    const id = publicationIntentId(intent);
    const createdAt = Date.now();
    await this.redis.eval(
      "if redis.call('HSETNX',KEYS[1],'data',ARGV[1]) == 1 then redis.call('ZADD',KEYS[2],ARGV[2],ARGV[3]) end return 1",
      2,
      this.#key(id),
      this.prefix,
      JSON.stringify({ ...intent, id, createdAt }),
      createdAt,
      id,
    );
    return id;
  }
  async recordReviewId(id: string, reviewId: number): Promise<void> {
    if (!Number.isSafeInteger(reviewId) || reviewId < 1)
      throw new TypeError("invalid publication intent receipt");
    await this.redis.eval(
      "if redis.call('EXISTS',KEYS[1]) == 1 then redis.call('HSET',KEYS[1],'reviewId',ARGV[1]) end return 1",
      1,
      this.#key(id),
      reviewId,
    );
  }
  async list(limit: number): Promise<readonly PendingPublicationIntent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError("invalid publication repair limit");
    const ids = await this.redis.zrange(this.prefix, 0, limit - 1);
    return Promise.all(
      ids.map(async (id) => {
        const fields = await this.redis.hgetall(this.#key(id));
        let entry: PendingPublicationIntent;
        try {
          entry = JSON.parse(fields.data!) as PendingPublicationIntent;
        } catch {
          throw new TypeError("invalid persisted publisher intent");
        }
        if (
          publicationIntentId(entry) !== id ||
          entry.id !== id ||
          !Number.isSafeInteger(entry.createdAt) ||
          entry.createdAt < 1
        )
          throw new TypeError("invalid persisted publisher intent identity");
        const reviewId =
          fields.reviewId === undefined ? undefined : Number(fields.reviewId);
        if (
          reviewId !== undefined &&
          (!Number.isSafeInteger(reviewId) || reviewId < 1)
        )
          throw new TypeError("invalid persisted publication receipt");
        return { ...entry, ...(reviewId === undefined ? {} : { reviewId }) };
      }),
    );
  }
  async touch(id: string): Promise<void> {
    this.#key(id);
    await this.redis.zadd(this.prefix, "XX", Date.now(), id);
  }
  async remove(id: string): Promise<void> {
    await this.redis.eval(
      "redis.call('DEL',KEYS[1]); redis.call('ZREM',KEYS[2],ARGV[1]); return 1",
      2,
      this.#key(id),
      this.prefix,
      id,
    );
  }
}
