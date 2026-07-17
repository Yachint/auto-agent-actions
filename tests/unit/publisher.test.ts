import { describe, expect, it, vi } from "vitest";

import { GitHubReviewPublisher } from "../../src/github/publisher.js";
import type { GitHubReviewClient } from "../../src/github/client.js";
import type { ExactDiff } from "../../src/repositories/diff.js";
import type { ReviewFinding } from "../../src/validation/review-output.js";

const headSha = "b".repeat(40);
const newerHeadSha = "c".repeat(40);
const diff: ExactDiff = {
  baseSha: "a".repeat(40),
  headSha,
  files: [{ status: "M", path: "src/app.ts", isDeleted: false, rightSideRanges: [{ start: 4, end: 8 }] }],
};

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    title: "Handle failure",
    body: "This failure terminates the worker.",
    priority: 1,
    confidence: 0.95,
    path: "src/app.ts",
    start_line: 4,
    end_line: 5,
    ...overrides,
  };
}

function client(currentHeadSha = headSha): GitHubReviewClient {
  return {
    getPullRequest: vi.fn().mockResolvedValue({
      state: "open",
      draft: false,
      headSha: currentHeadSha,
      headRepository: "owner/project",
    }),
    createReview: vi.fn().mockResolvedValue({ reviewId: 42 }),
  };
}

describe("GitHub review publisher", () => {
  it("revalidates anchors and publishes a COMMENT against the exact head", async () => {
    const github = client();
    const publisher = new GitHubReviewPublisher(github);
    await expect(
      publisher.publish({
        repository: "owner/project",
        pullRequestNumber: 7,
        reviewedHeadSha: headSha,
        exactDiff: diff,
        output: { status: "completed", findings: [finding()], summary: "One issue." },
      }),
    ).resolves.toEqual({ status: "published", reviewId: 42, comments: 1 });
    expect(github.createReview).toHaveBeenCalledWith({
      repository: "owner/project",
      pullRequestNumber: 7,
      commitId: headSha,
      event: "COMMENT",
      body: expect.stringContaining(`<!-- auto-agent-actions:head=${headSha} -->`),
      comments: [{
        path: "src/app.ts",
        body: "**P1: Handle failure**\n\nThis failure terminates the worker.",
        line: 5,
        side: "RIGHT",
        start_line: 4,
        start_side: "RIGHT",
      }],
    });
  });

  it("discards the entire result when the current head is newer", async () => {
    const github = client(newerHeadSha);
    const publisher = new GitHubReviewPublisher(github);
    await expect(
      publisher.publish({
        repository: "owner/project",
        pullRequestNumber: 7,
        reviewedHeadSha: headSha,
        exactDiff: diff,
        output: { status: "completed", findings: [finding()], summary: "One issue." },
      }),
    ).resolves.toEqual({ status: "stale", currentHeadSha: newerHeadSha });
    expect(github.createReview).not.toHaveBeenCalled();
  });

  it("does not contact GitHub when no validated, confident findings remain", async () => {
    const github = client();
    const publisher = new GitHubReviewPublisher(github);
    await expect(
      publisher.publish({
        repository: "owner/project",
        pullRequestNumber: 7,
        reviewedHeadSha: headSha,
        exactDiff: diff,
        output: {
          status: "completed",
          findings: [finding({ path: "outside.ts" }), finding({ confidence: 0.2 })],
          summary: "No publishable issues.",
        },
      }),
    ).resolves.toEqual({ status: "skipped", reason: "no-findings" });
    expect(github.getPullRequest).not.toHaveBeenCalled();
    expect(github.createReview).not.toHaveBeenCalled();
  });

  it("publishes a meaningful summary-only COMMENT when enabled", async () => {
    const github = client();
    const publisher = new GitHubReviewPublisher(github, { publishEmptySummary: true });
    await expect(
      publisher.publish({
        repository: "owner/project",
        pullRequestNumber: 7,
        reviewedHeadSha: headSha,
        exactDiff: diff,
        output: {
          status: "completed",
          findings: [],
          summary: "Reviewed the worker shutdown changes and error-handling flow.",
        },
      }),
    ).resolves.toEqual({ status: "published", reviewId: 42, comments: 0 });
    expect(github.createReview).toHaveBeenCalledWith({
      repository: "owner/project",
      pullRequestNumber: 7,
      commitId: headSha,
      event: "COMMENT",
      body: expect.stringContaining(
        "No actionable issues were found in the reviewed changes.",
      ),
      comments: [],
    });
    expect(github.createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(
          "Reviewed the worker shutdown changes and error-handling flow.",
        ),
      }),
    );
  });

  it("refuses closed, draft, and forked pull requests", async () => {
    for (const [state, expected] of [
      [{ state: "closed", draft: false, headSha, headRepository: "owner/project" }, "closed"],
      [{ state: "open", draft: true, headSha, headRepository: "owner/project" }, "draft"],
      [{ state: "open", draft: false, headSha, headRepository: "fork/project" }, "fork"],
    ] as const) {
      const github: GitHubReviewClient = {
        getPullRequest: vi.fn().mockResolvedValue(state),
        createReview: vi.fn().mockResolvedValue({ reviewId: 1 }),
      };
      const result = await new GitHubReviewPublisher(github).publish({
        repository: "owner/project",
        pullRequestNumber: 7,
        reviewedHeadSha: headSha,
        exactDiff: diff,
        output: { status: "completed", findings: [finding()], summary: "One issue." },
      });
      expect(result).toEqual({ status: "ineligible", reason: expected });
      expect(github.createReview).not.toHaveBeenCalled();
    }
  });
});
