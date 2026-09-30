import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { Redis } from "ioredis";

export class PublicationBusyError extends Error {
  constructor() {
    super("publication lease is held");
    this.name = "PublicationBusyError";
  }
}

/** Publisher-side fencing. Token-checked release cannot delete a successor's lease. */
export function redisPublicationLease(redis: Redis) {
  return async <T>(
    repository: string,
    number: number,
    action: (assertOwned: () => Promise<void>) => Promise<T>,
  ): Promise<T> => {
    const key = `auto-agent-actions:publication-lease:${createHash("sha256").update(`${repository}#${number}`).digest("hex")}`;
    const owner = randomUUID();
    if ((await redis.set(key, owner, "PX", 120_000, "NX")) !== "OK")
      throw new PublicationBusyError();
    let lost = false;
    const renew = setInterval(() => {
      void redis
        .eval(
          "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE',KEYS[1],ARGV[2]) end return 0",
          1,
          key,
          owner,
          120_000,
        )
        .then((result) => {
          if (result !== 1) lost = true;
        })
        .catch(() => {
          lost = true;
        });
    }, 30_000);
    renew.unref();
    try {
      const assertOwned = async () => {
        if (lost || (await redis.get(key)) !== owner)
          throw new PublicationBusyError();
      };
      const result = await action(assertOwned);
      if (lost)
        throw new Error("publication lease lost; recover receipt before retry");
      return result;
    } finally {
      clearInterval(renew);
      await redis.eval(
        "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
        1,
        key,
        owner,
      );
    }
  };
}
