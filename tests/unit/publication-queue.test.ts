import { describe, expect, it, vi } from "vitest";

import {
  BullMqPublicationQueue,
  validatePublicationRequest,
} from "../../src/queue/publication-queue.js";

const headSha = "b".repeat(40);
const valid = {
  reviewRequest: {
    deliveryId: "delivery-1",
    installationId: 77,
    repository: "owner/project",
    pullRequestNumber: 7,
    action: "synchronize",
    headSha,
  },
  exactDiff: {
    baseSha: "a".repeat(40),
    headSha,
    files: [
      {
        status: "M",
        path: "src/app.ts",
        isDeleted: false,
        rightSideRanges: [{ start: 2, end: 2 }],
      },
    ],
  },
  output: {
    status: "completed" as const,
    findings: [
      {
        title: "Finding",
        body: "Actionable issue.",
        priority: 1,
        confidence: 0.9,
        path: "src/app.ts",
        start_line: 2,
        end_line: 2,
      },
    ],
    summary: "One issue.",
    blocked_reason: null,
  },
};

describe("publication queue", () => {
  it("revalidates and enqueues a bounded idempotent publication job", async () => {
    const queue = { add: vi.fn().mockResolvedValue({}), close: vi.fn().mockResolvedValue(undefined) };
    const publications = new BullMqPublicationQueue({ queue });
    await publications.enqueue(validatePublicationRequest(valid));
    expect(queue.add).toHaveBeenCalledWith(
      "publish",
      expect.objectContaining({ reviewRequest: expect.objectContaining({ headSha }) }),
      expect.objectContaining({
        jobId: expect.stringMatching(/^[0-9a-f]{64}$/),
        attempts: 3,
        sizeLimit: 1024 * 1024,
      }),
    );
  });

  it("rejects a mismatched head or unsafe persisted diff path", () => {
    expect(() =>
      validatePublicationRequest({
        ...valid,
        exactDiff: { ...valid.exactDiff, headSha: "c".repeat(40) },
      }),
    ).toThrow(/does not match/);
    expect(() =>
      validatePublicationRequest({
        ...valid,
        exactDiff: {
          ...valid.exactDiff,
          files: [{ ...valid.exactDiff.files[0], path: "../secret" }],
        },
      }),
    ).toThrow(/path is invalid/);
    expect(() =>
      validatePublicationRequest({
        ...valid,
        exactDiff: {
          ...valid.exactDiff,
          files: [{ ...valid.exactDiff.files[0], previousPath: "../secret" }],
        },
      }),
    ).toThrow(/previousPath is invalid/);
  });

  it("rejects a blocked review at the persisted publication boundary", () => {
    expect(() =>
      validatePublicationRequest({
        ...valid,
        output: {
          status: "blocked",
          findings: [],
          summary: "The review could not be completed.",
          blocked_reason: "The filesystem sandbox was unavailable.",
        },
      }),
    ).toThrow(/must be completed before publication/);
  });
});
