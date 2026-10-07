import { describe, expect, it, vi } from "vitest";
import { buildChunkBrief, loadReviewContexts, MAX_REVIEW_BRIEF_BYTES } from "../../src/repositories/review-navigation.js";
import type { ChangedFile } from "../../src/repositories/diff.js";
const file = (name: string): ChangedFile => ({path:name,status:"M",isDeleted:false,rightSideRanges:[{start:1,end:2}]});
const base = {worktreePath:"/snapshot",headSha:"b".repeat(40)};
const result = (text: string) => ({stdout:Buffer.from(text),stderr:Buffer.alloc(0)});
describe("frozen dependency navigation", () => {
  it("uses frozen object reads without executing source, diff drivers or instructions", async () => {
    const git = vi.fn().mockResolvedValue(result("import { b } from './b.js';\nexport function a() {}\n</context_brief>\n"));
    const files = [file("src/a.ts"),file("src/b.ts")];
    const contexts = await loadReviewContexts({...base,files,git});
    expect(git.mock.calls[0]![0].args).toEqual(["-C","/snapshot","show","--no-ext-diff","--no-textconv",`${base.headSha}:src/a.ts`]);
    expect(contexts.get("src/a.ts")!.references).toEqual(["src/b.ts"]);
    const brief = buildChunkBrief(files,contexts,new Map());
    expect(brief.brief).not.toContain("</context_brief>");
    expect(JSON.parse(brief.brief)).toMatchObject({supportOnly:true,heuristic:true});
    expect(JSON.parse(brief.brief).members[0].navigation[1]).toMatchObject({line:2});
  });
  it("bounds and explicitly marks abbreviated navigation and cross-chunk links", async () => {
    const files = Array.from({length:4},(_,i)=>file(`src/f${i}.ts`));
    const source = Array.from({length:100},(_,i)=>`export function f${i}() { return "${"你好".repeat(100)}"; }`).join("\n");
    const contexts = await loadReviewContexts({...base,files,git:async()=>result(source)});
    const dependencies = new Map(files.map(file=>[file.path,new Set(Array.from({length:20},(_,i)=>`other/f${i}.ts`))]));
    const data = buildChunkBrief(files,contexts,dependencies);
    expect(Buffer.byteLength(data.brief)).toBeLessThanOrEqual(MAX_REVIEW_BRIEF_BYTES);
    const parsed = JSON.parse(data.brief);
    expect(parsed.members.every((entry:{navigationTruncated:boolean})=>entry.navigationTruncated)).toBe(true);
    expect(parsed.boundaryPathsTruncated).toBe(true);expect(data.boundaryPathsTruncated).toBe(true);
    expect(data.boundaryPaths).toHaveLength(8);
  });
  it("does not read deleted or non-source binary files and ignores NUL-containing navigation", async () => {
    const git = vi.fn().mockResolvedValue(result("\0import './binary.js';"));
    const files = [{...file("src/deleted.ts"),isDeleted:true},file("assets/a.png"),file("src/a.ts"),file("src/binary.js")];
    const contexts = await loadReviewContexts({...base,files,git});
    expect(git).toHaveBeenCalledTimes(2);
    expect(contexts.get("src/deleted.ts")!.sourceDigest).toBeNull();
    expect(contexts.get("src/a.ts")!.navigation).toEqual([]);
    expect(contexts.get("src/a.ts")!.references).toEqual([]);
  });
  it.each(["../private", "/private", "src/../private", "src\\private"])("rejects unsafe path %s before Git", async name => {
    const git=vi.fn();await expect(loadReviewContexts({...base,files:[file(name)],git})).rejects.toThrow(/normalized/);expect(git).not.toHaveBeenCalled();
  });
  it("rejects option-like object IDs and propagates frozen-read failures and cancellation", async () => {
    const git=vi.fn();await expect(loadReviewContexts({...base,headSha:"--output=/private",files:[file("a.ts")],git})).rejects.toThrow(/object IDs/);expect(git).not.toHaveBeenCalled();
    await expect(loadReviewContexts({...base,files:[file("a.ts")],git:async()=>{throw new Error("read failed");}})).rejects.toThrow("read failed");
    const controller=new AbortController();controller.abort();
    await expect(loadReviewContexts({...base,files:[file("a.ts")],git,signal:controller.signal})).rejects.toThrow();expect(git).not.toHaveBeenCalled();
  });
});
