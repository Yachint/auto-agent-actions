import type { Redis } from "ioredis";

export const workerHealthKey = (role: "analysis" | "publisher") =>
  `auto-agent-actions:worker-health:${role}`;

export function startWorkerHeartbeat(
  redis: Redis,
  role: "analysis" | "publisher",
  ready: () => boolean,
) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      if (ready())
        await redis.set(workerHealthKey(role), String(Date.now()), "EX", 30);
      else await redis.del(workerHealthKey(role));
    } catch {
      /* Readiness expires on Redis failure. */
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, 10_000);
  timer.unref();
  void tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await redis.del(workerHealthKey(role));
  };
}
