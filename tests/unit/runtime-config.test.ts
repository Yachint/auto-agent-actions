import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadAnalysisWorkerConfig,
  loadPublisherWorkerConfig,
  loadWebhookServerConfig,
} from "../../src/config/runtime.js";

const validEnvironment = {
  REDIS_URL: "redis://127.0.0.1:6379",
  GITHUB_WEBHOOK_SECRET: "a".repeat(32),
  GITHUB_ALLOWED_REPOSITORIES: "owner/project,owner/private-project",
};

describe("webhook server runtime configuration", () => {
  it("loads strict defaults and an explicit repository allowlist", async () => {
    await expect(loadWebhookServerConfig(validEnvironment)).resolves.toEqual({
      host: "127.0.0.1",
      port: 3000,
      logLevel: "info",
      redisUrl: "redis://127.0.0.1:6379",
      reviewQueueName: "pull-request-reviews",
      publicationQueueName: "pull-request-publications",
      reviewQueueDebounceMs: 1_000,
      webhookSecret: "a".repeat(32),
      allowedRepositories: new Set(["owner/project", "owner/private-project"]),
    });
  });

  it.each([
    [{ ...validEnvironment, REDIS_URL: "http://redis.example" }, /REDIS_URL/],
    [{ ...validEnvironment, GITHUB_WEBHOOK_SECRET: "short" }, /at least 32/],
    [{ ...validEnvironment, GITHUB_ALLOWED_REPOSITORIES: "owner/project,owner/project" }, /duplicates/],
    [{ ...validEnvironment, REVIEW_QUEUE_NAME: "unsafe:name" }, /safe queue/],
    [{ ...validEnvironment, PORT: "70000" }, /between 1 and 65535/],
  ])("fails closed for invalid configuration", async (environment, message) => {
    await expect(loadWebhookServerConfig(environment)).rejects.toThrow(message);
  });

  it("does not allow simultaneous inline and file-backed webhook secrets", async () => {
    await expect(
      loadWebhookServerConfig({
        ...validEnvironment,
        GITHUB_WEBHOOK_SECRET_FILE: "/run/secrets/webhook",
      }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it("loads analysis configuration without any GitHub App private key", async () => {
    const config = await loadAnalysisWorkerConfig({
      REDIS_URL: validEnvironment.REDIS_URL,
      GITHUB_ALLOWED_REPOSITORIES: "owner/project",
      READ_TOKEN_BROKER_SOCKET: "/run/auto-agent-actions/broker.sock",
      READ_TOKEN_BROKER_SECRET: "b".repeat(32),
      GITHUB_APP_PRIVATE_KEY_FILE: "/must/not/be/read.pem",
    });
    expect(config).toEqual(
      expect.objectContaining({
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        brokerSocketPath: "/run/auto-agent-actions/broker.sock",
        abandonedWorktreeAgeMs: 86_400_000,
      }),
    );
    expect(config).not.toHaveProperty("privateKey");
    expect(config).not.toHaveProperty("appId");
  });

  it("loads the App private key only for publisher configuration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "auto-agent-config-"));
    const keyPath = path.join(root, "app.pem");
    await writeFile(keyPath, "test-private-key");
    try {
      await expect(
        loadPublisherWorkerConfig({
          REDIS_URL: validEnvironment.REDIS_URL,
          GITHUB_ALLOWED_REPOSITORIES: "owner/project",
          READ_TOKEN_BROKER_SOCKET: "/run/auto-agent-actions/broker.sock",
          READ_TOKEN_BROKER_SECRET: "b".repeat(32),
          GITHUB_APP_ID: "12345",
          GITHUB_APP_PRIVATE_KEY_FILE: keyPath,
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          appId: "12345",
          privateKey: "test-private-key",
          reconciliationIntervalMs: 900_000,
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
