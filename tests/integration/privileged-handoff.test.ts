import { describe, expect, it, vi } from "vitest";

import type { InstallationTokenProvider } from "../../src/github/app-auth.js";
import type {
  GitHubRepositoryClient,
  GitHubReviewClient,
} from "../../src/github/client.js";
import type { PublicationRequest } from "../../src/queue/publication-queue.js";
import type { ReviewQueue, ReviewRequest } from "../../src/queue/review-queue.js";
import { InMemoryReviewStateStore } from "../../src/queue/review-state.js";
import { AnalysisJobProcessor } from "../../src/workflows/analysis-job.js";
import { PublicationJobProcessor } from "../../src/workflows/publication-job.js";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const newHeadSha = "c".repeat(40);
const reviewRequest: ReviewRequest = {
  deliveryId: "delivery-1",
  installationId: 77,
  repository: "owner/project",
  pullRequestNumber: 7,
  action: "synchronize",
  headSha,
};
const exactDiff = {
  baseSha,
  headSha,
  files: [
    {
      status: "M" as const,
      path: "src/app.ts",
      isDeleted: false,
      rightSideRanges: [{ start: 4, end: 5 }],
    },
  ],
};
const output = {
  status: "completed" as const,
  blocked_reason: null,
  findings: [
    {
      title: "Handle failure",
      body: "This failure terminates the worker.",
      priority: 1 as const,
      confidence: 0.95,
      path: "src/app.ts",
      start_line: 4,
      end_line: 5,
    },
  ],
  summary: "One issue.",
};

function tokenProvider(): InstallationTokenProvider {
  return {
    getToken: vi.fn().mockImplementation(async (_installation, _repository, purpose) => ({
      token: purpose === "repository-read" ? "read-token" : "write-token",
      expiresAt: new Date("2026-07-16T13:00:00Z"),
    })),
  };
}

function reviewQueue(): ReviewQueue & { enqueue: ReturnType<typeof vi.fn> } {
  return { enqueue: vi.fn().mockResolvedValue(undefined) };
}

function pullRequest(head = headSha): Awaited<ReturnType<GitHubRepositoryClient["getPullRequestDetails"]>> {
  return {
    state: "open",
    draft: false,
    headSha: head,
    headRepository: "owner/project",
    baseSha,
    baseBranch: "main",
    baseRepository: "owner/project",
    cloneUrl: "https://github.com/owner/project.git",
  };
}

describe("privilege-separated analysis to publication handoff", () => {
  it("uses read scope for analysis and hands validated output to the publication queue", async () => {
    const state = new InMemoryReviewStateStore();
    await state.recordRequested("owner/project", 7, headSha);
    const tokens = tokenProvider();
    const publications = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const runReview = vi.fn().mockResolvedValue({
      baseSha,
      headSha,
      exactDiff,
      review: output,
      rejectedFindings: [],
    });
    const processor = new AnalysisJobProcessor(
      {
        dataDirectory: "/trusted/data",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        timeoutMs: 60_000,
        schemaPath: "/trusted/review-schema.json",
        instructionsPath: "/trusted/review-instructions.md",
      },
      {
        allowedRepositories: new Set(["owner/project"]),
        stateStore: state,
        tokenProvider: tokens,
        reviewQueue: reviewQueue(),
        publicationQueue: publications,
        createRepositoryClient: () => ({
          getPullRequestDetails: vi.fn().mockResolvedValue(pullRequest()),
        }),
        runReview,
      },
    );

    await expect(processor.process(reviewRequest)).resolves.toBe("handed-off");
    expect(tokens.getToken).toHaveBeenCalledWith(77, "owner/project", "repository-read");
    expect(runReview).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteUrl: "https://github.com/owner/project.git",
        expectedBaseSha: baseSha,
        expectedHeadSha: headSha,
        fetchAuthentication: { installationToken: "read-token" },
      }),
    );
    expect(publications.enqueue).toHaveBeenCalledWith({
      reviewRequest: expect.objectContaining(reviewRequest),
      exactDiff,
      output,
    });
    expect(await state.get("owner/project", 7)).toEqual(
      expect.objectContaining({ status: "running", currentlyRunningHeadSha: headSha }),
    );
  });

  it("requeues the current API head without running Codex when the webhook head is stale", async () => {
    const state = new InMemoryReviewStateStore();
    await state.recordRequested("owner/project", 7, headSha);
    const reviews = reviewQueue();
    const runReview = vi.fn();
    const processor = new AnalysisJobProcessor(
      {
        dataDirectory: "/trusted/data",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        timeoutMs: 60_000,
        schemaPath: "/trusted/review-schema.json",
        instructionsPath: "/trusted/review-instructions.md",
      },
      {
        allowedRepositories: new Set(["owner/project"]),
        stateStore: state,
        tokenProvider: tokenProvider(),
        reviewQueue: reviews,
        publicationQueue: { enqueue: vi.fn() },
        createRepositoryClient: () => ({
          getPullRequestDetails: vi.fn().mockResolvedValue(pullRequest(newHeadSha)),
        }),
        runReview,
      },
    );

    await expect(processor.process(reviewRequest)).resolves.toBe("superseded");
    expect(runReview).not.toHaveBeenCalled();
    expect(reviews.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ headSha: newHeadSha, action: "synchronize" }),
    );
  });

  it("uses write scope only in the publisher and completes durable review state", async () => {
    const state = new InMemoryReviewStateStore();
    await state.recordRequested("owner/project", 7, headSha);
    await state.tryStart("owner/project", 7, headSha);
    const tokens = tokenProvider();
    const client: GitHubReviewClient = {
      getPullRequest: vi.fn().mockResolvedValue({
        state: "open",
        draft: false,
        headSha,
        headRepository: "owner/project",
      }),
      createReview: vi.fn().mockResolvedValue({ reviewId: 42 }),
    };
    const processor = new PublicationJobProcessor({
      allowedRepositories: new Set(["owner/project"]),
      stateStore: state,
      tokenProvider: tokens,
      reviewQueue: reviewQueue(),
      createReviewClient: () => client,
    });
    const publication: PublicationRequest = { reviewRequest, exactDiff, output };

    await expect(processor.process(publication)).resolves.toBe("published");
    expect(tokens.getToken).toHaveBeenCalledWith(77, "owner/project", "review-write");
    expect(client.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: "COMMENT", commitId: headSha }),
    );
    expect(await state.get("owner/project", 7)).toEqual(
      expect.objectContaining({
        status: "reviewed",
        currentlyRunningHeadSha: null,
        lastReviewedHeadSha: headSha,
      }),
    );
  });

  it("requeues a newer head discovered by the publisher and never posts the stale output", async () => {
    const state = new InMemoryReviewStateStore();
    await state.recordRequested("owner/project", 7, headSha);
    await state.tryStart("owner/project", 7, headSha);
    const reviews = reviewQueue();
    const client: GitHubReviewClient = {
      getPullRequest: vi.fn().mockResolvedValue({
        state: "open",
        draft: false,
        headSha: newHeadSha,
        headRepository: "owner/project",
      }),
      createReview: vi.fn(),
    };
    const processor = new PublicationJobProcessor({
      allowedRepositories: new Set(["owner/project"]),
      stateStore: state,
      tokenProvider: tokenProvider(),
      reviewQueue: reviews,
      createReviewClient: () => client,
    });

    await expect(
      processor.process({ reviewRequest, exactDiff, output }),
    ).resolves.toBe("superseded");
    expect(client.createReview).not.toHaveBeenCalled();
    expect(reviews.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ headSha: newHeadSha }),
    );
  });
});
