import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { InstallationTokenProvider } from "../../src/github/app-auth.js";
import {
  ReadTokenBrokerClient,
  ReadTokenBrokerServer,
} from "../../src/github/read-token-broker.js";

const runSocketTests = process.env.RUN_UNIX_SOCKET_TEST === "1";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("read-token broker Unix socket", () => {
  it.runIf(runSocketTests)("serves an authenticated repository-read token end to end", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "auto-agent-actions-broker-"));
    temporaryDirectories.push(directory);
    const socketPath = path.join(directory, "broker.sock");
    const sharedSecret = "s".repeat(32);
    const tokenProvider: InstallationTokenProvider = {
      getToken: vi.fn().mockResolvedValue({
        token: "ghs_socket_test_token",
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      }),
    };
    const server = new ReadTokenBrokerServer({
      socketPath,
      sharedSecret,
      allowedRepositories: new Set(["owner/project"]),
      tokenProvider,
    });

    await server.listen();
    try {
      const client = new ReadTokenBrokerClient({ socketPath, sharedSecret });
      await expect(client.getToken(77, "owner/project", "repository-read")).resolves.toEqual({
        token: "ghs_socket_test_token",
        expiresAt: expect.any(Date),
      });
      expect(tokenProvider.getToken).toHaveBeenCalledWith(77, "owner/project", "repository-read");
    } finally {
      await server.close();
    }
  });
});
