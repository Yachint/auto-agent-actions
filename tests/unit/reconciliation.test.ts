import { describe, expect, it, vi } from "vitest";

import { ReconciliationProcessor } from "../../src/workflows/reconciliation.js";

describe("pull request reconciliation", () => {
  it("enqueues eligible same-repository heads and leaves deduplication to the review queue", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const processor = new ReconciliationProcessor({
      allowedRepositories: new Set(["owner/project"]),
      installationProvider: { getRepositoryInstallationId: vi.fn().mockResolvedValue(77) },
      tokenProvider: {
        getToken: vi.fn().mockResolvedValue({
          token: "read-token",
          expiresAt: new Date(Date.now() + 60_000),
        }),
      },
      reviewQueue: { enqueue },
      createPullRequestClient: () => ({
        listOpenPullRequests: vi.fn().mockResolvedValue([
          {
            pullRequestNumber: 7,
            draft: false,
            headSha: "a".repeat(40),
            headRepository: "owner/project",
          },
          {
            pullRequestNumber: 8,
            draft: true,
            headSha: "b".repeat(40),
            headRepository: "owner/project",
          },
          {
            pullRequestNumber: 9,
            draft: false,
            headSha: "c".repeat(40),
            headRepository: "fork/project",
          },
        ]),
      }),
    });

    await expect(processor.run()).resolves.toEqual({
      repositoriesChecked: 1,
      pullRequestsSeen: 3,
      eligiblePullRequests: 1,
      repositoriesFailed: [],
    });
    expect(enqueue).toHaveBeenCalledWith({
      deliveryId: expect.stringMatching(/^reconcile-[0-9a-f]{64}$/),
      installationId: 77,
      repository: "owner/project",
      pullRequestNumber: 7,
      action: "synchronize",
      headSha: "a".repeat(40),
    });
  });

  it("continues after one repository fails without exposing error details", async () => {
    const processor = new ReconciliationProcessor({
      allowedRepositories: new Set(["owner/broken", "owner/project"]),
      installationProvider: {
        getRepositoryInstallationId: vi.fn(async (repository: string) => {
          if (repository === "owner/broken") throw new Error("sensitive response");
          return 77;
        }),
      },
      tokenProvider: {
        getToken: vi.fn().mockResolvedValue({
          token: "read-token",
          expiresAt: new Date(Date.now() + 60_000),
        }),
      },
      reviewQueue: { enqueue: vi.fn().mockResolvedValue(undefined) },
      createPullRequestClient: () => ({ listOpenPullRequests: vi.fn().mockResolvedValue([]) }),
    });

    await expect(processor.run()).resolves.toEqual({
      repositoriesChecked: 2,
      pullRequestsSeen: 0,
      eligiblePullRequests: 0,
      repositoriesFailed: ["owner/broken"],
    });
  });
});
