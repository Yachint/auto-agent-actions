import { describe, expect, it, vi } from "vitest";

import { BullMqReviewQueue } from "../../src/queue/bullmq-review-queue.js";
import { ReviewJobRunner } from "../../src/queue/review-job-runner.js";
import type { ReviewRequest } from "../../src/queue/review-queue.js";
import { InMemoryReviewStateStore } from "../../src/queue/review-state.js";

const oldHead = "a".repeat(40);
const newHead = "b".repeat(40);

function request(headSha = oldHead, deliveryId = "delivery-1"): ReviewRequest {
  return Object.freeze({
    deliveryId,
    installationId: 77,
    repository: "owner/project",
    pullRequestNumber: 7,
    action: "synchronize",
    headSha,
  });
}

describe("durable review queue behavior", () => {
  it("does not reset a retained failed job's attempts during reconciliation", async () => {
    const remove = vi.fn();
    const queue = { add: vi.fn(), close: vi.fn(), getJob: vi.fn().mockResolvedValue({ getState: async () => "failed", remove }) };
    const state = new InMemoryReviewStateStore();
    await state.recordRequested("owner/project", 7, oldHead);
    await state.tryStart("owner/project", 7, oldHead, "attempt");
    await state.fail("owner/project", 7, oldHead, "attempt");
    const reviews = new BullMqReviewQueue({queue, stateStore: state});
    for (let i = 0; i < 5; i++) await reviews.enqueue(request(oldHead, `reconcile-${i}`));
    expect(remove).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect((await state.get("owner/project", 7))?.analysisExhaustedScope).toBe(oldHead);
  });

  it("does not reset retries if the retained job fails during scheduling", async () => {
    const remove = vi.fn();
    const getState = vi.fn().mockResolvedValueOnce("delayed").mockResolvedValue("failed");
    const queue = { add: vi.fn(), close: vi.fn(), getJob: vi.fn().mockResolvedValue({ getState, remove }) };
    const state = new InMemoryReviewStateStore();
    await state.recordRequested("owner/project", 7, oldHead);
    await new BullMqReviewQueue({queue, stateStore: state}).enqueue(request());
    expect(remove).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect((await state.get("owner/project", 7))?.analysisExhaustedScope).toBe(oldHead);
  });

  it("keeps exhausted scopes stopped after queue retention expires, but permits an explicit new scope", async () => {
    const state = new InMemoryReviewStateStore();
    const queue = { add: vi.fn(), close: vi.fn(), getJob: vi.fn().mockResolvedValue(undefined) };
    const original = {...request(), baseBranch: "main", baseSha: newHead};
    const reviews = new BullMqReviewQueue({queue, stateStore: state});
    await reviews.enqueue(original);
    const scope = (await state.get("owner/project", 7))!.latestRequestedHeadSha;
    await state.tryStart("owner/project", 7, scope, "attempt");
    await state.fail("owner/project", 7, scope, "attempt");
    expect(await state.exhaustAnalysis("owner/project", 7, scope, "attempt")).toBe(true);
    queue.add.mockClear();
    const restarted = new BullMqReviewQueue({queue, stateStore: state});
    for (let i = 0; i < 5; i++) await restarted.enqueue({...original, deliveryId: `reconcile-${i}`});
    expect(queue.add).not.toHaveBeenCalled();
    expect(await state.tryStart("owner/project", 7, scope, "late-retry")).toBe(false);
    await restarted.enqueue({...original, rerunNonce: "operator-rerun"});
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect((await state.get("owner/project", 7))!.latestRequestedHeadSha).not.toBe(scope);
  });

  it("fences exhaustion against a replacement attempt, new scope and publication handoff", async () => {
    const state = new InMemoryReviewStateStore();
    await state.recordRequested("owner/project", 7, oldHead);
    await state.tryStart("owner/project", 7, oldHead, "old");
    await state.fail("owner/project", 7, oldHead, "old");
    await state.tryStart("owner/project", 7, oldHead, "new");
    expect(await state.exhaustAnalysis("owner/project", 7, oldHead, "old")).toBe(false);
    await state.handoff("owner/project", 7, oldHead, "{}", "new");
    expect(await state.exhaustAnalysis("owner/project", 7, oldHead, "new")).toBe(false);
    await state.recordRequested("owner/project", 7, newHead);
    expect(await state.exhaustAnalysis("owner/project", 7, oldHead, "new")).toBe(false);
    expect((await state.get("owner/project", 7))?.analysisExhaustedScope).toBeUndefined();
  });

  it("uses repairable per-scope job identities and bounded retries", async () => {
    const queue = {
      add: vi.fn().mockResolvedValue({}),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const state = new InMemoryReviewStateStore();
    const reviews = new BullMqReviewQueue({
      queue,
      stateStore: state,
      debounceMs: 2_000,
    });

    await reviews.enqueue(request());
    await reviews.enqueue(request());
    await reviews.enqueue(request(newHead, "delivery-2"));

    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenLastCalledWith(
      "review",
      request(newHead, "delivery-2"),
      expect.objectContaining({
        delay: 2_000,
        attempts: 2,
        backoff: { type: "exponential", delay: 1_000 },
      }),
    );
    const firstOptions = queue.add.mock.calls[0]![2];
    const secondOptions = queue.add.mock.calls[1]![2];
    expect(firstOptions.deduplication).toBeUndefined();
    expect(firstOptions.jobId).not.toBe(secondOptions.jobId);
  });

  it("supersedes an active run when a newer head is requested", async () => {
    const state = new InMemoryReviewStateStore();
    const runner = new ReviewJobRunner(state);
    await state.recordRequested("owner/project", 7, oldHead);

    const result = await runner.run(request(), async (lease) => {
      expect(await lease.canPublish()).toBe(true);
      await state.recordRequested("owner/project", 7, newHead);
      expect(await lease.canPublish()).toBe(false);
    });

    expect(result).toBe("superseded");
    expect(await state.get("owner/project", 7)).toEqual(
      expect.objectContaining({
        latestRequestedHeadSha: newHead,
        currentlyRunningHeadSha: null,
        lastReviewedHeadSha: null,
        status: "queued",
      }),
    );
    await expect(
      runner.run(request(newHead, "delivery-2"), async () => {}),
    ).resolves.toBe("completed");
  });

  it("records failure and permits the same head to be requested again", async () => {
    const state = new InMemoryReviewStateStore();
    const runner = new ReviewJobRunner(state);
    await state.recordRequested("owner/project", 7, oldHead);
    await expect(
      runner.run(request(), async () => {
        throw new Error("transient failure");
      }),
    ).rejects.toThrow(/transient failure/);
    expect(await state.get("owner/project", 7)).toEqual(
      expect.objectContaining({
        status: "failed",
        currentlyRunningHeadSha: null,
      }),
    );
    await expect(
      state.recordRequested("owner/project", 7, oldHead),
    ).resolves.toBe(true);
  });

  it("makes state retryable when BullMQ insertion fails", async () => {
    const queue = {
      add: vi
        .fn()
        .mockRejectedValueOnce(new Error("Redis unavailable"))
        .mockResolvedValueOnce({}),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const state = new InMemoryReviewStateStore();
    const reviews = new BullMqReviewQueue({ queue, stateStore: state });

    await expect(reviews.enqueue(request())).rejects.toThrow(
      /Redis unavailable/,
    );
    expect(await state.get("owner/project", 7)).toEqual(
      expect.objectContaining({ status: "failed" }),
    );
    await expect(reviews.enqueue(request())).resolves.toBeUndefined();
    expect(queue.add).toHaveBeenCalledTimes(2);
  });

  it("does not start a queued job for an obsolete head", async () => {
    const state = new InMemoryReviewStateStore();
    const process = vi.fn().mockResolvedValue(undefined);
    await state.recordRequested("owner/project", 7, oldHead);
    await state.recordRequested("owner/project", 7, newHead);
    await expect(
      new ReviewJobRunner(state).run(request(), process),
    ).resolves.toBe("superseded");
    expect(process).not.toHaveBeenCalled();
  });

  it("does not rerun a retained job for an already-reviewed head", async () => {
    const state = new InMemoryReviewStateStore();
    const runner = new ReviewJobRunner(state);
    const process = vi.fn().mockResolvedValue(undefined);
    await state.recordRequested("owner/project", 7, oldHead);
    await expect(runner.run(request(), async () => {})).resolves.toBe(
      "completed",
    );

    await expect(runner.run(request(), process)).resolves.toBe("superseded");
    expect(process).not.toHaveBeenCalled();
  });
});
