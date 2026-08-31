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
      now: () => new Date("2026-08-31T18:00:00.000Z"),
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

  it("uses a fresh delivery identity on each run so a retained failed job cannot block recovery", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    let now = new Date("2026-08-31T18:00:00.000Z");
    const processor = new ReconciliationProcessor({
      allowedRepositories: new Set(["owner/project"]),
      installationProvider: { getRepositoryInstallationId: vi.fn().mockResolvedValue(77) },
      tokenProvider: {
        getToken: vi.fn().mockResolvedValue({ token: "read-token", expiresAt: new Date() }),
      },
      reviewQueue: { enqueue },
      now: () => now,
      createPullRequestClient: () => ({
        listOpenPullRequests: vi.fn().mockResolvedValue([
          {
            pullRequestNumber: 7,
            draft: false,
            headSha: "a".repeat(40),
            headRepository: "owner/project",
          },
        ]),
      }),
    });

    await processor.run();
    now = new Date("2026-08-31T18:15:00.000Z");
    await processor.run();

    const firstDelivery = enqueue.mock.calls[0]![0].deliveryId;
    const secondDelivery = enqueue.mock.calls[1]![0].deliveryId;
    expect(firstDelivery).not.toBe(secondDelivery);
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
