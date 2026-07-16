import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";

const apps = [] as ReturnType<typeof buildApp>[];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("health endpoints", () => {
  it("reports that the process is live", async () => {
    const app = buildApp();
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/health/live",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("reports that the service is ready", async () => {
    const app = buildApp();
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
  });

  it("reports not ready when a required dependency is unavailable", async () => {
    const app = buildApp({ readiness: async () => false });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not_ready" });
  });

  it("exposes internal metrics only when a provider is configured", async () => {
    const app = buildApp({
      metrics: {
        record: async () => undefined,
        snapshot: async () => ({ review_queue_active: 2 }),
      },
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("auto_agent_actions_review_queue_active 2\n");
  });
});
