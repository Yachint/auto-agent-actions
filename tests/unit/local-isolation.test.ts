import { expect, it, vi } from "vitest";
import { loadReviewIsolationConfig } from "../../src/config/runtime.js";
import { reviewPolicyHash } from "../../src/queue/policy.js";
import { runLocalReview } from "../../src/workflows/local-review.js";
import { runReviewCore } from "../../src/workflows/review-core.js";
vi.mock("../../src/workflows/review-core.js", () => ({
  runReviewCore: vi
    .fn()
    .mockResolvedValue({
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      review: {
        status: "completed",
        blocked_reason: null,
        summary: "Result",
        findings: [],
      },
      rejectedFindings: [],
    }),
}));
it.each([
  { REVIEW_ISOLATE_CODEX: "true" },
  { REVIEW_SANDBOX_BINARY: "/trusted/review-sandbox" },
])(
  "passes the effective isolation configuration to local/evaluation execution (%j)",
  async (environment) => {
    await runLocalReview({
      environment,
      fixture: {
        action: "opened",
        number: 1,
        repository: {
          full_name: "owner/project",
          clone_url: "https://github.com/owner/project.git",
        },
        pull_request: {
          state: "open",
          draft: false,
          base: {
            ref: "main",
            sha: "a".repeat(40),
            repo: { full_name: "owner/project" },
          },
          head: { sha: "b".repeat(40), repo: { full_name: "owner/project" } },
        },
      },
      dataDirectory: "/trusted/data",
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
      timeoutMs: 1800000,
      schemaPath: "/trusted/schema",
      instructionsPath: "/trusted/instructions",
    });
    expect(runReviewCore).toHaveBeenLastCalledWith(
      expect.objectContaining(loadReviewIsolationConfig(environment)),
      {},
    );
    expect(reviewPolicyHash(environment)).toBe(
      reviewPolicyHash({ ...environment, REVIEW_ISOLATE_CODEX: "true" }),
    );
    expect(reviewPolicyHash(environment)).not.toBe(reviewPolicyHash({}));
  },
);
it("rejects malformed isolation flags even with an explicit binary", () => {
  expect(() =>
    loadReviewIsolationConfig({
      REVIEW_ISOLATE_CODEX: "yes",
      REVIEW_SANDBOX_BINARY: "/trusted/sandbox",
    }),
  ).toThrow("REVIEW_ISOLATE_CODEX");
  expect(() =>
    loadReviewIsolationConfig({ REVIEW_SANDBOX_BINARY: "relative" }),
  ).toThrow("REVIEW_SANDBOX_BINARY");
});
