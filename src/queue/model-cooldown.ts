import { createHash } from "node:crypto";

interface CooldownRedis {
  pttl(key: string): Promise<number>;
  eval(script: string, numberOfKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/** Queue-wide, restart-safe cooldown. Concurrent failures can only extend it. */
export class ModelCooldownStore {
  readonly #key: string;
  constructor(readonly redis: CooldownRedis, queueName: string) {
    this.#key = `auto-agent-actions:model-cooldown:${createHash("sha256").update(queueName).digest("hex")}`;
  }

  async remainingMs(): Promise<number> {
    const ttl = await this.redis.pttl(this.#key);
    if (ttl === -1) throw new Error("model cooldown is missing its expiry");
    return Math.max(0, ttl);
  }

  async defer(retryAt: number): Promise<number> {
    if (!Number.isSafeInteger(retryAt)) throw new TypeError("invalid model cooldown");
    const delay = Math.min(7 * 24 * 60 * 60 * 1000, Math.max(1000, retryAt - Date.now()));
    const ttl = await this.redis.eval(`
local ttl = redis.call('PTTL', KEYS[1])
if ttl == -1 then return -1 end
if ttl < tonumber(ARGV[1]) then
  redis.call('SET', KEYS[1], 'blocked', 'PX', ARGV[1])
  return tonumber(ARGV[1])
end
return ttl`, 1, this.#key, delay);
    if (typeof ttl !== "number" || ttl < 0) throw new Error("invalid model cooldown expiry");
    return ttl;
  }
}
