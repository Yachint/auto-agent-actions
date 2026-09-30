import { describe, expect, it, vi } from "vitest";
import { BullMqReviewQueue } from "../../src/queue/bullmq-review-queue.js";
import { InMemoryReviewStateStore } from "../../src/queue/review-state.js";
import { reviewScope } from "../../src/queue/review-queue.js";
import { GitHubReviewPublisher } from "../../src/github/publisher.js";
import { githubPatchRanges } from "../../src/github/diff.js";
import { scoreReview } from "../../src/validation/evaluation.js";

const repository = "owner/project";
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const request = {
  repository,
  installationId: 1,
  pullRequestNumber: 1,
  headSha,
  baseSha,
  baseBranch: "main",
  action: "opened" as const,
  deliveryId: "one",
};
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

it("repairs an orphaned scheduling intent and preserves forced generations during reconciliation", async () => {
  const state = new InMemoryReviewStateStore();
  const queue = {
    add: vi.fn().mockResolvedValue({}),
    close: vi.fn(),
    getJob: vi.fn().mockResolvedValue(undefined),
  };
  const reviews = new BullMqReviewQueue({
    queue,
    stateStore: state,
    policyHash: "policy",
  });
  await reviews.enqueue({ ...request, rerunNonce: "forced" });
  const scope = reviewScope(queue.add.mock.calls[0]![1]);
  await reviews.enqueue({ ...request, deliveryId: "reconciliation" });
  expect(reviewScope(queue.add.mock.calls[1]![1])).toBe(scope);
  await reviews.enqueue({ ...request, baseBranch: "release" });
  expect(reviewScope(queue.add.mock.calls[2]![1])).not.toBe(scope);
});

it("fences old attempts after lease recovery", async () => {
  const state = new InMemoryReviewStateStore();
  await state.recordRequested(repository, 1, headSha);
  expect(await state.tryStart(repository, 1, headSha, "old")).toBe(true);
  expect(await state.tryStart(repository, 1, headSha, "duplicate")).toBe(false);
  await state.fail(repository, 1, headSha, "old");
  expect(await state.tryStart(repository, 1, headSha, "new")).toBe(true);
  expect(await state.handoff(repository, 1, headSha, "{}", "old")).toBe(false);
  await state.fail(repository, 1, headSha, "old");
  expect(await state.canPublish(repository, 1, headSha, "new")).toBe(true);
});

it("releases analysis ownership while its artifact awaits publication", async () => {
  const state = new InMemoryReviewStateStore();
  await state.recordRequested(repository, 1, headSha);
  await state.tryStart(repository, 1, headSha, "analysis");
  await state.handoff(repository, 1, headSha, "{}", "analysis");
  expect(await state.canPublish(repository, 1, headSha)).toBe(true);
  await state.recordRequested(repository, 1, baseSha);
  expect(await state.tryStart(repository, 1, baseSha, "next")).toBe(true);
  expect(await state.complete(repository, 1, headSha)).toBe(false);
  expect(await state.canPublish(repository, 1, baseSha, "next")).toBe(true);
});

it("uses publisher-owned anchors and never labels rejected findings clean", async () => {
  const client = {
    getPullRequest: vi.fn().mockResolvedValue({
      state: "open",
      draft: false,
      headSha,
      headRepository: repository,
    }),
    getReviewDiff: vi.fn().mockResolvedValue({ ...exactDiff, files: [] }),
    createReview: vi.fn().mockResolvedValue({ reviewId: 1 }),
  };
  await new GitHubReviewPublisher(client, {
    publishEmptySummary: true,
  }).publish({
    repository,
    pullRequestNumber: 1,
    reviewedHeadSha: headSha,
    exactDiff,
    output,
  });
  expect(client.createReview).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "COMMENT",
      comments: [],
      body: expect.stringContaining("no clean conclusion"),
    }),
  );
});

it("recovers an accepted review without a second POST", async () => {
  const client = {
    getPullRequest: vi.fn().mockResolvedValue({
      state: "open",
      draft: false,
      headSha,
      headRepository: repository,
    }),
    findReview: vi.fn().mockResolvedValue({ reviewId: 42 }),
    createReview: vi.fn(),
  };
  expect(
    await new GitHubReviewPublisher(client).publish({
      repository,
      pullRequestNumber: 1,
      reviewedHeadSha: headSha,
      exactDiff,
      output,
    }),
  ).toMatchObject({ status: "published", reviewId: 42 });
  expect(client.createReview).not.toHaveBeenCalled();
});

it("keeps lower-severity findings advisory", async () => {
  const client = {
    getPullRequest: vi.fn().mockResolvedValue({
      state: "open",
      draft: false,
      headSha,
      headRepository: repository,
    }),
    createReview: vi.fn().mockResolvedValue({ reviewId: 1 }),
  };
  await new GitHubReviewPublisher(client).publish({
    repository,
    pullRequestNumber: 1,
    reviewedHeadSha: headSha,
    exactDiff,
    output: { ...output, findings: [{ ...finding, priority: 3 }] },
  });
  expect(client.createReview).toHaveBeenCalledWith(
    expect.objectContaining({ event: "COMMENT" }),
  );
});

it("rejects base retargets at the same head", async () => {
  const client = {
    getPullRequest: vi.fn().mockResolvedValue({
      state: "open",
      draft: false,
      headSha,
      headRepository: repository,
      baseSha,
      baseBranch: "release",
    }),
    createReview: vi.fn(),
  };
  expect(
    await new GitHubReviewPublisher(client).publish({
      repository,
      pullRequestNumber: 1,
      reviewedHeadSha: headSha,
      reviewedBaseBranch: "main",
      exactDiff,
      output,
    }),
  ).toMatchObject({ status: "stale", currentBaseBranch: "release" });
  expect(client.createReview).not.toHaveBeenCalled();
});

it("extracts additions rather than context from GitHub patches", () => {
  expect(
    githubPatchRanges(
      "@@ -1,4 +1,5 @@\n context\n-old\n+new\n context\n+extra\n context",
    ),
  ).toEqual([
    { start: 2, end: 2 },
    { start: 4, end: 4 },
  ]);
});

it("does not count duplicate findings as additional confirmed defects", () => {
  expect(
    scoreReview({ ...output, findings: [finding, finding] }, [
      {
        id: "defect",
        path: "file.ts",
        startLine: 2,
        endLine: 2,
        titleIncludes: "guard",
      },
    ]),
  ).toMatchObject({ matched: 1, recall: 1, precision: 0.5 });
});

it.each([false, true])(
  "authorizes comment commands using fresh GitHub permissions (%s)",
  async (authorized) => {
    const { PublicationJobProcessor } = await import(
      "../../src/workflows/publication-job.js"
    );
    const enqueue = vi.fn();
    const cooldown = vi.fn().mockResolvedValue(true);
    const client = {
      getReviewCommand: vi.fn().mockResolvedValue({
        body: "/codex-review",
        userType: "User",
        login: "maintainer",
        createdAt: new Date().toISOString(),
      }),
      canRequestReview: vi.fn().mockResolvedValue(authorized),
      getPullRequest: vi.fn().mockResolvedValue({
        state: "open",
        draft: false,
        headRepository: repository,
        headSha: baseSha,
        baseSha: headSha,
        baseBranch: "release",
      }),
      createReview: vi.fn(),
    };
    const processor = new PublicationJobProcessor({
      allowedRepositories: new Set([repository]),
      stateStore: new InMemoryReviewStateStore(),
      tokenProvider: {
        getToken: vi.fn().mockResolvedValue({
          token: "synthetic",
          expiresAt: new Date(Date.now() + 60000),
        }),
      },
      reviewQueue: { enqueue },
      enableCommentCommands: true,
      claimCommandCooldown: cooldown,
      createReviewClient: () => client,
    });
    expect(
      await processor.process({ reviewRequest: request, commentId: 123 }),
    ).toBe(authorized ? "rereview-scheduled" : "skipped");
    if (authorized)
      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          headSha: baseSha,
          baseSha: headSha,
          baseBranch: "release",
          rerunNonce: expect.any(String),
        }),
      );
    else {
      expect(enqueue).not.toHaveBeenCalled();
      expect(cooldown).not.toHaveBeenCalled();
    }
    expect(client.createReview).not.toHaveBeenCalled();
  },
);

it("does not post a status check for an obsolete base tip", async () => {
  const { PublicationJobProcessor } = await import(
    "../../src/workflows/publication-job.js"
  );
  const stateStore = new InMemoryReviewStateStore();
  await stateStore.recordRequested(repository, 1, headSha);
  const setCheckStatus = vi.fn();
  const processor = new PublicationJobProcessor({
    allowedRepositories: new Set([repository]),
    stateStore,
    tokenProvider: {
      getToken: vi
        .fn()
        .mockResolvedValue({ token: "synthetic", expiresAt: new Date() }),
    },
    reviewQueue: { enqueue: vi.fn() },
    enableChecks: true,
    createReviewClient: () => ({
      getPullRequest: vi.fn().mockResolvedValue({
        state: "open",
        draft: false,
        headRepository: repository,
        headSha,
        baseSha: "c".repeat(40),
        baseBranch: "main",
      }),
      createReview: vi.fn(),
      setCheckStatus,
    }),
  });
  expect(
    await processor.process({ reviewRequest: request, stage: "queued" }),
  ).toBe("superseded");
  expect(setCheckStatus).not.toHaveBeenCalled();
});

it("does not overwrite a worker lease after an ambiguous queue insertion", async () => {
  const state = new InMemoryReviewStateStore();
  await state.recordRequested(repository, 1, headSha);
  await state.tryStart(repository, 1, headSha, "owner");
  await state.enqueueFailed(repository, 1, headSha);
  expect((await state.get(repository, 1))?.status).toBe("running");
  expect(await state.canPublish(repository, 1, headSha, "owner")).toBe(true);
});
