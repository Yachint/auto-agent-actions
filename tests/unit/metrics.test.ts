import { describe, expect, it } from "vitest";

import {
  RedisOperationalMetrics,
  renderPrometheusMetrics,
} from "../../src/observability/metrics.js";

describe("operational metrics", () => {
  it("stores bounded counters and renders stable Prometheus names", async () => {
    const values = new Map<string, number>();
    const metrics = new RedisOperationalMetrics({
      hincrby: async (_key, field, increment) => {
        const next = (values.get(field) ?? 0) + increment;
        values.set(field, next);
        return next;
      },
      hgetall: async () => Object.fromEntries([...values].map(([name, value]) => [name, String(value)])),
    });

    await metrics.record("webhooks_enqueued_total");
    await metrics.record("webhooks_enqueued_total", 2);
    expect(await metrics.snapshot()).toEqual({ webhooks_enqueued_total: 3 });
    expect(renderPrometheusMetrics(await metrics.snapshot())).toBe(
      "auto_agent_actions_webhooks_enqueued_total 3\n",
    );
    await expect(metrics.record("unsafe-name")).rejects.toThrow(/name is invalid/);
  });
});
