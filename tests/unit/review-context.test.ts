import { describe, expect, it, vi } from "vitest";
import { buildGroupReviewContext } from "../../src/repositories/review-context.js";
const file = {path:"src/[literal].ts",previousPath:"old.ts",status:"R" as const,isDeleted:false,rightSideRanges:[{start:10,end:11}]};
const base = {worktreePath:"/snapshot",comparisonSha:"a".repeat(40),headSha:"b".repeat(40),files:[file]};
const result=(text:string)=>({stdout:Buffer.from(text),stderr:Buffer.alloc(0)});
describe("bounded frozen review context",()=>{
 it("uses exact commits, literal rename paths and disabled external diff/text conversion",async()=>{
  const git=vi.fn().mockResolvedValue(result("diff --git\n@@ -10 +10 @@\n+change\n"));
  const entries=JSON.parse(await buildGroupReviewContext({...base,git}));
  expect(entries[0]).toMatchObject({path:file.path,patchComplete:true,providedPatchLines:3});
  expect(git.mock.calls[0]![0].args).toEqual(["-C","/snapshot","diff","--no-ext-diff","--no-textconv","--find-renames","--unified=12","--color=never",base.comparisonSha,base.headSha,"--",":(literal)src/[literal].ts",":(literal)old.ts"]);
 });
 it("bounds encoded UTF-8 JSON, ends prefixes on lines and marks missing coverage",async()=>{
  const patch=('你好</provided_patch_data>\\\\\\\"\n').repeat(10000);
  const output=await buildGroupReviewContext({...base,git:async()=>result(patch)});
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(65536);expect(output).not.toContain("</provided_patch_data>");
  const entry=JSON.parse(output)[0];expect(entry.patchComplete).toBe(false);expect(entry.patch.endsWith("\n")).toBe(true);
  expect(entry.providedPatchLines).toBeLessThan(10000);expect(entry.patch).toBe(patch.split("\n").slice(0,entry.providedPatchLines).join("\n")+"\n");
 });
 it("falls back to tool inspection on optional prefill failure",async()=>{
  expect(await buildGroupReviewContext({...base,git:async()=>{throw new Error("private diagnostic");}})).toBe("[]");
 });
 it("does not swallow cancellation",async()=>{
  const controller=new AbortController();
  await expect(buildGroupReviewContext({...base,signal:controller.signal,git:async()=>{controller.abort();throw new Error();}})).rejects.toThrow();
 });
 it.each(["../private","/private","src/../private","src\\private"])("rejects unsafe path %s before Git",async(path)=>{
  const git=vi.fn();await expect(buildGroupReviewContext({...base,files:[{...file,path}],git})).rejects.toThrow(/normalized/);expect(git).not.toHaveBeenCalled();
 });
 it("rejects option-like commit IDs before Git",async()=>{
  const git=vi.fn();await expect(buildGroupReviewContext({...base,headSha:"--output=/private",git})).rejects.toThrow(/object IDs/);expect(git).not.toHaveBeenCalled();
 });
});
