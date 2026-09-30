import { expect, it, vi } from "vitest";
import { GitHubRestClient } from "../../src/github/client.js";
import { GitHubReviewPublisher } from "../../src/github/publisher.js";
import { findingIdentity } from "../../src/github/finding-identity.js";
import { InMemoryReviewStateStore } from "../../src/queue/review-state.js";
import { reviewScope } from "../../src/queue/review-queue.js";
import { PublicationJobProcessor } from "../../src/workflows/publication-job.js";
import { PublicationRepairProcessor } from "../../src/workflows/publication-repair.js";
import {
  publicationIntentId,
  type PublicationIntentStore,
  type PendingPublicationIntent,
} from "../../src/queue/publication-intents.js";

const repository = "owner/project",
  headSha = "a".repeat(40),
  baseSha = "b".repeat(40),
  nextSha = "c".repeat(40);
const finding = {
  path: "file.ts",
  title: "Guard failure",
  body: "A concrete failure",
  priority: 1 as const,
  confidence: 0.95,
  start_line: 2,
  end_line: 2,
};
const output = {
  status: "completed" as const,
  blocked_reason: null,
  summary: "Result",
  findings: [finding],
};
const exactDiff = {
  baseSha,
  headSha,
  files: [
    {
      status: "M" as const,
      path: "file.ts",
      isDeleted: false,
      rightSideRanges: [{ start: 2, end: 2 }],
    },
  ],
};
const input = {
  repository,
  pullRequestNumber: 1,
  reviewedHeadSha: headSha,
  reviewedBaseBranch: "main",
  exactDiff,
  output,
};

// Exercises the real REST adapter with only documented routes, including identity and markers.
function github() {
  let currentHead = headSha;
  let failPost = true,
    failDismiss = false,
    failPostRead = false;
  const reviews: Array<{
    id: number;
    commit_id: string;
    body: string;
    state: string;
    user: { id: number; type: string };
  }> = [];
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async (url, init) => {
      const route = new URL(String(url)).pathname;
      const json = (value: unknown) => new Response(JSON.stringify(value));
      if (route === "/users/test-app%5Bbot%5D")
        return json({ id: 7, type: "Bot" });
      if (route === "/repos/owner/project/pulls/1") {
        if (failPostRead && reviews.length) {
          failPostRead = false;
          throw new Error("lost post-write GET");
        }
        return json({
          state: "open",
          draft: false,
          base: {
            sha: baseSha,
            ref: "main",
            repo: {
              full_name: repository,
              clone_url: "https://github.com/owner/project.git",
            },
          },
          head: { sha: currentHead, repo: { full_name: repository } },
        });
      }
      if (route === "/repos/owner/project/pulls/1/files")
        return json([
          {
            filename: "file.ts",
            status: "modified",
            patch: "@@ -1 +1,2 @@\n context\n+added",
          },
        ]);
      if (route === "/repos/owner/project/pulls/1/reviews") {
        if (init?.method === "GET") return json(reviews);
        const body = JSON.parse(String(init?.body)) as {
          body: string;
          commit_id: string;
          event: string;
        };
        reviews.push({
          id: 42,
          body: body.body,
          commit_id: body.commit_id,
          state:
            body.event === "REQUEST_CHANGES"
              ? "CHANGES_REQUESTED"
              : "COMMENTED",
          user: { id: 7, type: "Bot" },
        });
        if (failPost) {
          failPost = false;
          throw new Error("accepted POST but lost response");
        }
        return json({ id: 42 });
      }
      if (
        route === "/repos/owner/project/pulls/1/reviews/42/dismissals" &&
        init?.method === "PUT"
      ) {
        if (failDismiss) {
          failDismiss = false;
          throw new Error("dismissal unavailable");
        }
        reviews[0]!.state = "DISMISSED";
        return json({ id: 42 });
      }
      if (route === "/graphql")
        return json({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      isResolved: false,
                      comments: {
                        nodes: [
                          {
                            author: {
                              login: "test-app[bot]",
                              __typename: "Bot",
                            },
                            body: `<!-- auto-agent-actions:finding=${findingIdentity(finding)} -->`,
                            url: "https://github.com/owner/project/pull/1#discussion_r5",
                          },
                        ],
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          },
        });
      throw new Error(`unexpected GitHub route ${route}`);
    });
  const client = new GitHubRestClient({
    installationToken: "synthetic-write-token",
    appIdentity: { appId: 7, botLogin: "test-app[bot]" },
    fetch,
  });
  return {
    client,
    fetch,
    reviews,
    advance: () => {
      currentHead = nextSha;
    },
    failDismiss: () => {
      failDismiss = true;
    },
    postReadFailure: () => {
      failPost = false;
      failPostRead = true;
    },
  };
}

it("recovers a lost review response with continuity links and a trailing marker", async () => {
  const api = github();
  const publisher = new GitHubReviewPublisher(api.client, {
    findingContinuity: true,
  });
  await expect(publisher.publish(input)).rejects.toThrow(
    "GitHub API request failed",
  );
  expect(api.reviews[0]!.body).toContain("continuing discussion");
  expect(api.reviews[0]!.body).toMatch(
    /<!-- auto-agent-actions:review=[a-f0-9]{64} -->$/,
  );
  await expect(publisher.publish(input)).resolves.toMatchObject({
    status: "published",
    reviewId: 42,
  });
  expect(api.reviews).toHaveLength(1);
});

it("dismisses an accepted blocking review on retry after a push", async () => {
  const api = github(),
    publisher = new GitHubReviewPublisher(api.client);
  await expect(publisher.publish(input)).rejects.toThrow();
  api.advance();
  await expect(publisher.publish(input)).resolves.toMatchObject({
    status: "stale",
    currentHeadSha: nextSha,
  });
  expect(api.reviews).toHaveLength(1);
  expect(api.reviews[0]!.state).toBe("DISMISSED");
});

function memoryIntents(): PublicationIntentStore {
  const entries = new Map<string, PendingPublicationIntent>();
  return {
    prepare: async (value) => {
      const id = publicationIntentId(value);
      if (!entries.has(id))
        entries.set(id, { ...value, id, createdAt: Date.now() });
      return id;
    },
    recordReviewId: async (id, reviewId) => {
      const entry = entries.get(id);
      if (entry) entries.set(id, { ...entry, reviewId });
    },
    list: async (limit) => [...entries.values()].slice(0, limit),
    touch: async () => {},
    remove: async (id) => {
      entries.delete(id);
    },
  };
}

it.each(["POST", "post-write GET"])(
  "repairs a superseded blocking review after failed %s even when its analysis artifact is gone",
  async (failure) => {
    const api = github();
    if (failure === "post-write GET") api.postReadFailure();
    const stateStore = new InMemoryReviewStateStore(),
      intents = memoryIntents();
    const request = {
      repository,
      pullRequestNumber: 1,
      installationId: 1,
      headSha,
      baseSha,
      baseBranch: "main",
      action: "opened" as const,
      deliveryId: "test",
    };
    const publication = { reviewRequest: request, exactDiff, output };
    const scope = reviewScope(request);
    await stateStore.recordRequested(repository, 1, scope);
    await stateStore.tryStart(repository, 1, scope, "analysis");
    await stateStore.handoff(
      repository,
      1,
      scope,
      JSON.stringify(publication),
      "analysis",
    );
    const dependencies = {
      allowedRepositories: new Set([repository]),
      stateStore,
      tokenProvider: {
        getToken: vi.fn().mockResolvedValue({
          token: "synthetic",
          expiresAt: new Date(Date.now() + 3600000),
        }),
      },
      reviewQueue: { enqueue: vi.fn() },
      createReviewClient: () => api.client,
      publicationIntents: intents,
    };
    const processor = new PublicationJobProcessor(dependencies);
    await expect(processor.process(publication)).rejects.toThrow();
    expect(await intents.list(10)).toHaveLength(1);
    api.advance();
    await stateStore.recordRequested(repository, 1, nextSha);
    expect(
      (await stateStore.get(repository, 1))?.publicationArtifact,
    ).toBeUndefined();
    await expect(processor.process(publication)).resolves.toBe("superseded");
    const repair = new PublicationRepairProcessor(dependencies, intents);
    api.failDismiss();
    await expect(repair.run()).rejects.toThrow();
    expect(await intents.list(10)).toHaveLength(1);
    await repair.run();
    expect(api.reviews[0]!.state).toBe("DISMISSED");
    expect(api.reviews).toHaveLength(1);
    expect(await intents.list(10)).toHaveLength(0);
    expect((await stateStore.get(repository, 1))?.latestRequestedHeadSha).toBe(
      nextSha,
    );
  },
);

it("does not recover a marker copied by a human, another bot, or into prose", async () => {
  const marker = `<!-- auto-agent-actions:review=${"d".repeat(64)} -->`;
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).includes("/users/")
            ? { id: 7, type: "Bot" }
            : [
                {
                  id: 1,
                  user: { id: 7, type: "User" },
                  commit_id: headSha,
                  body: marker,
                  state: "REQUEST_CHANGES",
                },
                {
                  id: 2,
                  user: { id: 8, type: "Bot" },
                  commit_id: headSha,
                  body: marker,
                  state: "REQUEST_CHANGES",
                },
                {
                  id: 3,
                  user: { id: 7, type: "Bot" },
                  commit_id: nextSha,
                  body: marker,
                  state: "REQUEST_CHANGES",
                },
                {
                  id: 4,
                  user: { id: 7, type: "Bot" },
                  commit_id: headSha,
                  body: `${marker}\nquoted text`,
                  state: "REQUEST_CHANGES",
                },
              ],
        ),
      ),
  );
  const client = new GitHubRestClient({
    installationToken: "synthetic",
    appIdentity: { appId: 7, botLogin: "test-app[bot]" },
    fetch,
  });
  await expect(
    client.findReview(repository, 1, headSha, marker),
  ).resolves.toBeNull();
});
