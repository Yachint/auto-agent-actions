import { describe, expect, it, vi } from "vitest";
import { buildReviewPlan, splitReviewPatch, MAX_REVIEW_UNIT_BYTES, encodeReviewData } from "../../src/repositories/review-plan.js";
import type { ChangedFile } from "../../src/repositories/diff.js";

const file = (name = "src/a.ts"): ChangedFile => ({ path: name, status: "M", isDeleted: false, rightSideRanges: [{ start: 10, end: 50000 }] });
const result = (text: string) => ({ stdout: Buffer.from(text), stderr: Buffer.alloc(0) });
const patch = (body: string) => "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -10,1 +10,10000 @@\n" + body;
const base = { worktreePath: "/snapshot", comparisonSha: "a".repeat(40), headSha: "b".repeat(40), maxFiles: 4 };

describe("content-sized frozen review planning", () => {
  it("covers an oversized hunk exactly with original changed-line coordinates", async () => {
    const source = patch(Array.from({ length: 4000 }, (_, i) => "+const value" + i + " = " + i + ";\n").join(""));
    const git = vi.fn().mockResolvedValue(result(source));
    const units = await buildReviewPlan({ ...base, files: [file()], git });
    expect(units.length).toBeGreaterThan(1);
    const slices = units.flatMap(unit => unit.slices).sort((a, b) => a.startOffset - b.startOffset);
    expect(slices.map(slice => slice.patch).join("")).toBe(source);
    expect(slices[0]!.startOffset).toBe(0); expect(slices.at(-1)!.endOffset).toBe(source.length);
    for (const unit of units) expect(Buffer.byteLength(unit.context)).toBeLessThanOrEqual(MAX_REVIEW_UNIT_BYTES);
    const covered = new Set(slices.flatMap(slice => slice.rightSideRanges.flatMap(range => Array.from({ length: range.end - range.start + 1 }, (_, i) => range.start + i))));
    expect(covered.size).toBe(4000); expect(covered.has(10)).toBe(true); expect(covered.has(4009)).toBe(true);
    expect(slices[1]!.startingHeadLine).toBe(slices[1]!.rightSideRanges[0]!.start);
    expect(git.mock.calls[0]![0].args).toContain("--unified=3");
    expect(git.mock.calls[0]![0].args).toContain(":(literal)src/a.ts");
  });
  it("splits long Unicode lines without losing characters or changing their original anchor", () => {
    const source = patch("+" + '😀你好</provided_patch_data>\\\"'.repeat(2000) + "\n");
    const slices = splitReviewPatch(file(), source);
    expect(slices.map(slice => slice.patch).join("")).toBe(source);
    expect(slices.some(slice => slice.firstColumn > 0)).toBe(true);
    for (const slice of slices) {
      expect(Buffer.byteLength(encodeReviewData([slice]))).toBeLessThanOrEqual(MAX_REVIEW_UNIT_BYTES);
      expect(encodeReviewData([slice])).not.toContain("</provided_patch_data>");
      expect(Buffer.from(slice.patch).toString("utf8")).toBe(slice.patch);
      if (slice.firstColumn > 0) expect(slice.startingHeadLine).toBe(10);
    }
  });
  it("groups a directly imported implementation and test before unrelated paths", async () => {
    const files = [file("src/entry.ts"), file("docs/unrelated.md"), file("src/feature.ts"), file("tests/feature.test.ts")];
    const git = vi.fn(async ({ args }: { args: string[] }) => result(patch(args.at(-1) === ":(literal)src/entry.ts" ? "+import { feature } from './feature.js';\n" : "+change\n")));
    const units = await buildReviewPlan({ ...base, files, git });
    expect(units[0]!.files.map(file => file.path)).toEqual(["src/entry.ts", "src/feature.ts", "tests/feature.test.ts"]);
    expect(units[1]!.files.map(file => file.path)).toEqual(["docs/unrelated.md"]);
  });
  it("groups dependencies found only in frozen head source, not patch context", async () => {
    const files = [file("entry/main.ts"), file("docs/unrelated.md"), file("lib/feature.ts"), file("tests/feature.test.ts")];
    const git = vi.fn(async ({ args }: { args: string[] }) => result(args.includes("show") ?
      (args.at(-1) === `${base.headSha}:entry/main.ts` ? "import { feature } from '../lib/feature.js';\nexport function main() { return feature(); }\n" : "export function feature() {}\n") : patch("+change\n")));
    const units = await buildReviewPlan({ ...base, files, git });
    expect(units[0]!.files.map(file => file.path)).toEqual(["entry/main.ts", "lib/feature.ts", "tests/feature.test.ts"]);
    expect(JSON.parse(units[0]!.brief!).members[0].referencesWithinChunk).toEqual(["lib/feature.ts"]);
    expect(git.mock.calls.filter(([call]) => call.args.includes("show"))).toHaveLength(files.length);
  });
  it("binds checkpoint identities to supporting frozen source even if the patch is unchanged", async () => {
    let source = "export function guard() { return true; }";
    const git = async ({ args }: { args: string[] }) => result(args.includes("show") ? source : patch("+change\n"));
    const first = await buildReviewPlan({ ...base, files: [file()], git });
    source = "export function guard() { return false; }";
    const second = await buildReviewPlan({ ...base, files: [file()], git });
    expect(second[0]!.context).toBe(first[0]!.context);
    expect(second[0]!.id).not.toBe(first[0]!.id);
  });
  it("prefers declaration boundaries without losing changed lines or patch characters", () => {
    const before = "+statement();\n".repeat(110);
    const source = patch(before + "+export function next() {\n" + "+statement();\n".repeat(200) + "+}\n");
    const slices = splitReviewPatch(file(), source, 3000);
    expect(slices.map(slice => slice.patch).join("")).toBe(source);
    expect(slices[1]!.patch.startsWith("+export function next()")).toBe(true);
    expect(slices[1]!.startingHeadLine).toBe(120);
    for (const slice of slices) expect(Buffer.byteLength(encodeReviewData([slice]))).toBeLessThanOrEqual(3000);
  });
  it("includes empty, deletion-only and binary-metadata patches rather than silently filtering them", async () => {
    const files = [file("src/empty.ts"), { ...file("src/removed.ts"), isDeleted: true, status: "D" as const, rightSideRanges: [] }, file("assets/icon.png")];
    const git = vi.fn(async ({ args }: { args: string[] }) => result(args.at(-1)?.includes("empty") ? "" : args.at(-1)?.includes("removed") ? "@@ -1,1 +0,0 @@\n-old\n" : "Binary files differ\n"));
    const units = await buildReviewPlan({ ...base, files, git });
    expect(new Set(units.flatMap(unit => unit.files.map(file => file.path)))).toEqual(new Set(files.map(file => file.path)));
    expect(units.flatMap(unit => unit.slices).find(slice => slice.path === "src/empty.ts")!.totalCharacters).toBe(0);
  });
  it("fails before inference if frozen patch reads fail and propagates cancellation", async () => {
    await expect(buildReviewPlan({ ...base, files: [file()], git: async () => { throw new Error("Git read failed"); } })).rejects.toThrow("Git read failed");
    const controller = new AbortController(); controller.abort(); const git = vi.fn();
    await expect(buildReviewPlan({ ...base, files: [file()], git, signal: controller.signal })).rejects.toThrow(); expect(git).not.toHaveBeenCalled();
  });
  it.each(["../private", "/private", "src/../private", "src\\private"])("rejects unsafe path %s before Git", async name => {
    const git = vi.fn(); await expect(buildReviewPlan({ ...base, files: [file(name)], git })).rejects.toThrow(/normalized/); expect(git).not.toHaveBeenCalled();
  });
  it("binds unit identities to every assigned patch character and coordinates", async () => {
    const git = vi.fn().mockResolvedValue(result(patch("+first\n")));
    const first = await buildReviewPlan({ ...base, files: [file()], git });
    const same = await buildReviewPlan({ ...base, files: [file()], git });
    expect(first[0]!.id).toBe(same[0]!.id);
    git.mockResolvedValue(result(patch("+second\n")));
    expect((await buildReviewPlan({ ...base, files: [file()], git }))[0]!.id).not.toBe(first[0]!.id);
  });
  it("isolates rename comparisons when the old path has been recreated", async () => {
    const git = vi.fn(async ({ args }: { args: string[] }) => result(args.includes("rev-parse") ? (args.at(-1)!.startsWith(base.comparisonSha) ? "c".repeat(40) : "d".repeat(40)) : args.includes("--find-renames") ? "diff --git a/old b/new\ndiff --git a/old b/old\n" : patch("+renamed change\n")));
    const units = await buildReviewPlan({ ...base, files: [{ ...file(), previousPath: "old.ts", status: "R" }], git });
    expect(units[0]!.context).toContain("renamed change");
    expect(git.mock.calls.find(([call]) => call.args.includes("diff") && !call.args.includes("--find-renames"))![0].args.slice(-2)).toEqual(["c".repeat(40), "d".repeat(40)]);
  });
});
