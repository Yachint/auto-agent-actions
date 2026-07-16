import { describe, expect, it, vi } from "vitest";

import type { InstallationTokenProvider } from "../../src/github/app-auth.js";
import {
  authorizeReadTokenRequest,
  ReadTokenBrokerClient,
} from "../../src/github/read-token-broker.js";

const secret = "s".repeat(32);

function provider(): InstallationTokenProvider {
  return {
    getToken: vi.fn().mockResolvedValue({
      token: "ghs_read_only_token",
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
    }),
  };
}

describe("read-only installation token broker", () => {
  it("authorizes only allowlisted repository-read token requests", async () => {
    const tokens = provider();
    const result = await authorizeReadTokenRequest(
      `Bearer ${secret}`,
      Buffer.from(JSON.stringify({ installation_id: 77, repository: "owner/project" })),
      {
        sharedSecret: secret,
        allowedRepositories: new Set(["owner/project"]),
        tokenProvider: tokens,
      },
    );
    expect(result).toEqual({
      statusCode: 200,
      body: {
        token: "ghs_read_only_token",
        expires_at: expect.any(String),
      },
    });
    expect(tokens.getToken).toHaveBeenCalledWith(77, "owner/project", "repository-read");
  });

  it("rejects invalid authentication and repositories outside the allowlist", async () => {
    const tokens = provider();
    const options = {
      sharedSecret: secret,
      allowedRepositories: new Set(["owner/project"]),
      tokenProvider: tokens,
    };
    await expect(
      authorizeReadTokenRequest(
        `Bearer ${"x".repeat(32)}`,
        Buffer.from(JSON.stringify({ installation_id: 77, repository: "owner/project" })),
        options,
      ),
    ).resolves.toEqual({ statusCode: 401, body: { error: "unauthorized" } });
    await expect(
      authorizeReadTokenRequest(
        `Bearer ${secret}`,
        Buffer.from(JSON.stringify({ installation_id: 77, repository: "other/project" })),
        options,
      ),
    ).resolves.toEqual({
      statusCode: 403,
      body: { error: "repository is not allowlisted" },
    });
    expect(tokens.getToken).not.toHaveBeenCalled();
  });

  it("parses successful responses but refuses write-token requests client-side", async () => {
    const request = vi.fn().mockResolvedValue({
      statusCode: 200,
      body: Buffer.from(
        JSON.stringify({
          token: "ghs_read_only_token",
          expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
        }),
      ),
    });
    const client = new ReadTokenBrokerClient({
      socketPath: "/run/auto-agent-actions/broker.sock",
      sharedSecret: secret,
      request,
    });
    await expect(client.getToken(77, "owner/project", "repository-read")).resolves.toEqual({
      token: "ghs_read_only_token",
      expiresAt: expect.any(Date),
    });
    await expect(client.getToken(77, "owner/project", "review-write")).rejects.toThrow(
      /cannot issue write tokens/,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
});
