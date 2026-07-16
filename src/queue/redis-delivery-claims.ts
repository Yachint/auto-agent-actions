import { createHash } from "node:crypto";

import type { DeliveryClaims } from "./review-queue.js";
import type { RedisScriptClient } from "./redis-review-state.js";

const CLAIM_COMMAND = "autoAgentClaimWebhookDelivery";

export class RedisDeliveryClaims implements DeliveryClaims {
  readonly #redis: RedisScriptClient;
  readonly #ttlSeconds: number;

  constructor(redis: RedisScriptClient, ttlSeconds = 7 * 24 * 60 * 60) {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) {
      throw new TypeError("ttlSeconds must be a positive integer");
    }
    this.#redis = redis;
    this.#ttlSeconds = ttlSeconds;
    redis.defineCommand(CLAIM_COMMAND, {
      numberOfKeys: 1,
      lua: "if redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1]) then return 1 else return 0 end",
    });
  }

  async claim(deliveryId: string): Promise<boolean> {
    const key = deliveryKey(deliveryId);
    const result = await this.#redis.runCommand(CLAIM_COMMAND, [key, String(this.#ttlSeconds)]);
    if (result !== 0 && result !== 1 && result !== "0" && result !== "1") {
      throw new Error("Redis delivery claim command returned an invalid result");
    }
    return result === 1 || result === "1";
  }

  async release(deliveryId: string): Promise<void> {
    await this.#redis.del(deliveryKey(deliveryId));
  }
}

function deliveryKey(deliveryId: string): string {
  if (deliveryId.length === 0 || deliveryId.length > 200 || /[\0\r\n]/.test(deliveryId)) {
    throw new TypeError("deliveryId must be a bounded single-line identifier");
  }
  return `auto-agent-actions:webhook-delivery:${createHash("sha256")
    .update(deliveryId)
    .digest("hex")}`;
}
