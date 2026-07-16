import { generateKeyPairSync, verify } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createAppJwt, GitHubAppAuth } from "../../src/github/app-auth.js";

const now = new Date("2026-07-16T12:00:00.000Z");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

describe("GitHub App authentication", () => {
  it("creates a short-lived RS256 app JWT with clock-drift allowance", () => {
    const jwt = createAppJwt("12345", privateKey, now);
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({
      iat: Math.floor(now.getTime() / 1_000) - 60,
      exp: Math.floor(now.getTime() / 1_000) - 60 + 9 * 60,
      iss: "12345",
    });
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
  });

  it("requests and caches a repository-scoped least-privilege installation token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "ghs_new_variable_length_token_format",
          expires_at: "2026-07-16T13:00:00.000Z",
        }),
        { status: 201 },
      ),
    );
    const auth = new GitHubAppAuth({
      appId: "12345",
      privateKey: privateKeyPem,
      fetch,
      now: () => now,
    });

    const first = await auth.getToken(77, "owner/project", "repository-read");
    const second = await auth.getToken(77, "owner/project", "repository-read");

    expect(first).toEqual({
      token: "ghs_new_variable_length_token_format",
      expiresAt: new Date("2026-07-16T13:00:00.000Z"),
    });
    expect(second).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, request] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/app/installations/77/access_tokens");
    expect(JSON.parse(String(request!.body))).toEqual({
      repositories: ["project"],
      permissions: { contents: "read", pull_requests: "read" },
    });
    expect((request!.headers as Record<string, string>).Authorization).toMatch(/^Bearer eyJ/);
  });

  it("uses distinct token requests for repository and publisher privileges", async () => {
    let tokenNumber = 0;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      tokenNumber += 1;
      return new Response(
        JSON.stringify({
          token: `token-${tokenNumber}`,
          expires_at: "2026-07-16T13:00:00.000Z",
        }),
        { status: 201 },
      );
    });
    const auth = new GitHubAppAuth({
      appId: "12345",
      privateKey: privateKeyPem,
      fetch,
      now: () => now,
    });

    await auth.getToken(77, "owner/project", "repository-read");
    await auth.getToken(77, "owner/project", "review-write");

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body)).permissions).toEqual({
      contents: "read",
      pull_requests: "read",
    });
    expect(JSON.parse(String(fetch.mock.calls[1]![1]!.body)).permissions).toEqual({
      pull_requests: "write",
    });
  });

  it("resolves the installation for an allowlisted repository with an App JWT", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 77 }), { status: 200 }),
    );
    const auth = new GitHubAppAuth({
      appId: "12345",
      privateKey: privateKeyPem,
      fetch,
      now: () => now,
    });

    await expect(auth.getRepositoryInstallationId("owner/project")).resolves.toBe(77);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/project/installation",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: expect.stringMatching(/^Bearer eyJ/) }),
      }),
    );
  });

  it("does not expose private keys or GitHub response bodies in errors", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: "sensitive response" }), { status: 403 }),
    );
    const auth = new GitHubAppAuth({
      appId: "12345",
      privateKey: privateKeyPem,
      fetch,
      now: () => now,
    });
    const error = await auth
      .getToken(77, "owner/project", "review-write")
      .catch((value: unknown) => value);
    expect(String(error)).toBe(
      "GitHubApiError: GitHub installation token endpoint returned HTTP 403",
    );
    expect(String(error)).not.toContain("PRIVATE KEY");
    expect(String(error)).not.toContain("sensitive response");
  });
});
