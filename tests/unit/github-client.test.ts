import { describe, expect, it, vi } from "vitest";

import { GitHubApiError, GitHubRestClient } from "../../src/github/client.js";

const headSha = "a".repeat(40);

describe("GitHub REST client", () => {
  it("reads current pull request state with versioned installation authentication", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          state: "open",
          draft: false,
          head: { sha: headSha, repo: { full_name: "owner/project" } },
          base: {
            sha: "b".repeat(40),
            ref: "main",
            repo: {
              full_name: "owner/project",
              clone_url: "https://github.com/owner/project.git",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new GitHubRestClient({ installationToken: "secret-token", fetch });

    await expect(client.getPullRequest("owner/project", 7)).resolves.toEqual({
      state: "open",
      draft: false,
      headSha,
      headRepository: "owner/project",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/project/pulls/7",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer secret-token",
          "X-GitHub-Api-Version": "2026-03-10",
        }),
      }),
    );
  });

  it("reads exact base and clone details for the analysis worker", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          state: "open",
          draft: false,
          head: { sha: headSha, repo: { full_name: "owner/project" } },
          base: {
            sha: "b".repeat(40),
            ref: "main",
            repo: {
              full_name: "owner/project",
              clone_url: "https://github.com/owner/project.git",
            },
          },
        }),
        { status: 200 },
      ),
    );
    const client = new GitHubRestClient({ installationToken: "secret-token", fetch });
    await expect(client.getPullRequestDetails("owner/project", 7)).resolves.toEqual({
      state: "open",
      draft: false,
      headSha,
      headRepository: "owner/project",
      baseSha: "b".repeat(40),
      baseBranch: "main",
      baseRepository: "owner/project",
      cloneUrl: "https://github.com/owner/project.git",
    });
  });

  it("lists open pull requests for reconciliation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            number: 7,
            state: "open",
            draft: false,
            head: { sha: headSha, repo: { full_name: "owner/project" } },
          },
        ]),
        { status: 200 },
      ),
    );
    const client = new GitHubRestClient({ installationToken: "secret-token", fetch });
    await expect(client.listOpenPullRequests("owner/project")).resolves.toEqual([
      {
        pullRequestNumber: 7,
        draft: false,
        headSha,
        headRepository: "owner/project",
      },
    ]);
    expect(fetch.mock.calls[0]![0]).toBe(
      "https://api.github.com/repos/owner/project/pulls?state=open&per_page=100&page=1",
    );
  });

  it("creates a changes-requested review using right-side line anchors", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 99 }), { status: 200 }),
    );
    const client = new GitHubRestClient({ installationToken: "secret-token", fetch });
    await expect(
      client.createReview({
        repository: "owner/project",
        pullRequestNumber: 7,
        commitId: headSha,
        body: "Summary",
        event: "REQUEST_CHANGES",
        comments: [{ path: "src/app.ts", body: "Finding", line: 5, side: "RIGHT" }],
      }),
    ).resolves.toEqual({ reviewId: 99 });
    const request = fetch.mock.calls[0]![1]!;
    expect(JSON.parse(String(request.body))).toEqual({
      commit_id: headSha,
      body: "Summary",
      event: "REQUEST_CHANGES",
      comments: [{ path: "src/app.ts", body: "Finding", line: 5, side: "RIGHT" }],
    });
  });

  it("does not include response bodies or credentials in API errors", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: "sensitive response" }), { status: 403 }),
    );
    const client = new GitHubRestClient({ installationToken: "secret-token", fetch });
    const error = await client.getPullRequest("owner/project", 7).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(String(error)).toBe("GitHubApiError: GitHub API returned HTTP 403");
    expect(String(error)).not.toContain("secret-token");
    expect(String(error)).not.toContain("sensitive response");
  });
});
