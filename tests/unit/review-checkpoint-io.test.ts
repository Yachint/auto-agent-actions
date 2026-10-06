import { constants } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const handle = { stat: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), sync: vi.fn(), close: vi.fn() };
  return { handle, open: vi.fn(), mkdir: vi.fn(), rename: vi.fn(), rm: vi.fn() };
});
vi.mock("node:fs/promises", () => mocks);
import { DiskReviewCheckpointStore } from "../../src/codex/review-checkpoints.js";

const key = "a".repeat(64);
const file = `/protected/checkpoints/${key}.json`;
const output = { status: "completed" as const, blocked_reason: null, findings: [], summary: "Inspected all requested paths." };
const store = new DiskReviewCheckpointStore("/protected/checkpoints");
beforeEach(() => {
  vi.resetAllMocks();
  mocks.open.mockResolvedValue(mocks.handle);
  mocks.handle.stat.mockResolvedValue({ isFile: () => true, size: 300, mode: 0o100600 });
  mocks.handle.readFile.mockResolvedValue(JSON.stringify({ key, paths: ["a.ts"], output }));
});

describe("protected checkpoint IO", () => {
  it("uses no-follow reads and rejects symlinks without consuming content", async () => {
    mocks.open.mockRejectedValue(Object.assign(new Error("symlink"), { code: "ELOOP" }));
    await expect(store.read(key, ["a.ts"])).rejects.toThrow();
    expect(mocks.open).toHaveBeenCalledWith(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    expect(mocks.handle.readFile).not.toHaveBeenCalled();
  });
  it.each([
    { isFile: () => true, size: 300, mode: 0o100644 },
    { isFile: () => true, size: 1024 * 1024 + 1, mode: 0o100600 },
    { isFile: () => false, size: 300, mode: 0o040700 },
  ])("rejects unprotected, oversized, or non-regular files", async (info) => {
    mocks.handle.stat.mockResolvedValue(info);
    await expect(store.read(key, ["a.ts"])).rejects.toThrow(/protected bounded/);
    expect(mocks.handle.readFile).not.toHaveBeenCalled();
    expect(mocks.handle.close).toHaveBeenCalled();
  });
  it("atomically replaces a checkpoint only after a private exclusive write and sync", async () => {
    await store.write(key, ["a.ts"], output);
    expect(mocks.mkdir).toHaveBeenCalledWith("/protected/checkpoints", { recursive: true, mode: 0o700 });
    const temporary = mocks.open.mock.calls[0]![0];
    expect(temporary).toMatch(/^[\/a-z0-9.-]+\.tmp$/);
    expect(mocks.open).toHaveBeenCalledWith(temporary, "wx", 0o600);
    expect(mocks.handle.sync.mock.invocationCallOrder[0]).toBeLessThan(mocks.rename.mock.invocationCallOrder[0]!);
    expect(mocks.rename).toHaveBeenCalledWith(temporary, file);
  });
  it("does not replace a checkpoint when the write fails and removes only its own temporary file", async () => {
    mocks.handle.writeFile.mockRejectedValue(new Error("disk full"));
    await expect(store.write(key, ["a.ts"], output)).rejects.toThrow("disk full");
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalledWith(mocks.open.mock.calls[0]![0], { force: true });
    expect(mocks.handle.close).toHaveBeenCalled();
  });
});
