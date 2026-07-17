import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import { InMemoryDeliveryClaims, type ReviewRequest } from "../../src/queue/review-queue.js";

const secret = "test-webhook-secret";
const repository = "owner/project";
const headSha = "b".repeat(40);

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "opened",
    installation: { id: 123 },
    number: 7,
    repository: { full_name: repository },
    pull_request: {
      state: "open",
      draft: false,
      base: { repo: { full_name: repository } },
      head: { sha: headSha, repo: { full_name: repository } },
    },
    ...overrides,
  };
}

function signature(body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function makeApp(enqueue = vi.fn<(request: ReviewRequest) => Promise<void>>().mockResolvedValue()) {
  return {
    app: buildApp({
      webhook: {
        secret,
        allowedRepositories: new Set([repository]),
        queue: { enqueue },
        deliveryClaims: new InMemoryDeliveryClaims(),
      },
    }),
    enqueue,
  };
}

async function inject(
  app: ReturnType<typeof buildApp>,
  body: string,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url: "/webhooks/github",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-1",
      "x-hub-signature-256": signature(body),
      ...headers,
    },
    payload: body,
  });
}

describe("GitHub webhook ingestion", () => {
  it("verifies and enqueues a minimal immutable review request", async () => {
    const { app, enqueue } = makeApp();
    const body = JSON.stringify(payload());

    const response = await inject(app, body);

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ enqueued: true });
    expect(enqueue).toHaveBeenCalledWith({
      deliveryId: "delivery-1",
      installationId: 123,
      repository,
      pullRequestNumber: 7,
      action: "opened",
      headSha,
    });
    expect(Object.isFrozen(enqueue.mock.calls[0]![0])).toBe(true);
    await app.close();
  });

  it("accepts a signed GitHub App ping without enqueueing work", async () => {
    const { app, enqueue } = makeApp();
    const body = JSON.stringify({ zen: "Keep it logically awesome." });

    const response = await inject(app, body, { "x-github-event": "ping" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ping: true });
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  it.each(["installation", "installation_repositories"])(
    "acknowledges the mandatory %s lifecycle event without enqueueing work",
    async (event) => {
      const { app, enqueue } = makeApp();
      const body = JSON.stringify({ action: "created" });

      const response = await inject(app, body, { "x-github-event": event });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ignored: true });
      expect(enqueue).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it("rejects an invalid signature before enqueueing", async () => {
    const { app, enqueue } = makeApp();
    const response = await inject(app, JSON.stringify(payload()), {
      "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
    });
    expect(response.statusCode).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  it("deduplicates repeated delivery IDs", async () => {
    const { app, enqueue } = makeApp();
    const body = JSON.stringify(payload());
    expect((await inject(app, body)).json()).toEqual({ enqueued: true });
    expect((await inject(app, body)).json()).toEqual({ enqueued: false });
    expect(enqueue).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("releases a delivery claim when enqueueing fails", async () => {
    const enqueue = vi
      .fn<(request: ReviewRequest) => Promise<void>>()
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockResolvedValueOnce();
    const { app } = makeApp(enqueue);
    const body = JSON.stringify(payload());
    expect((await inject(app, body)).statusCode).toBe(500);
    expect((await inject(app, body)).statusCode).toBe(202);
    expect(enqueue).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it.each([
    ["a repository outside the allowlist", payload({ repository: { full_name: "other/project" }, pull_request: { state: "open", draft: false, base: { repo: { full_name: "other/project" } }, head: { sha: headSha, repo: { full_name: "other/project" } } } }), 403],
    ["a fork", payload({ pull_request: { state: "open", draft: false, base: { repo: { full_name: repository } }, head: { sha: headSha, repo: { full_name: "fork/project" } } } }), 422],
    ["an unsupported action", payload({ action: "closed" }), 422],
  ])("rejects %s", async (_name, value, statusCode) => {
    const { app, enqueue } = makeApp();
    const response = await inject(app, JSON.stringify(value));
    expect(response.statusCode).toBe(statusCode);
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });
});
