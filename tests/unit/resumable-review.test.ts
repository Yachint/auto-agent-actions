import { describe, expect, it, vi } from "vitest";
import { DiskReviewCheckpointStore } from "../../src/codex/review-checkpoints.js";
import { runResumableReview } from "../../src/workflows/resumable-review.js";
import { ModelUsageLimitError } from "../../src/codex/model-limit.js";
import { loadReviewBatchFiles } from "../../src/config/runtime.js";
import { reviewPolicyHash } from "../../src/queue/policy.js";
import type { CodexRunnerOptions } from "../../src/codex/runner.js";

const files = Array.from({length:5},(_,i)=>({path:`file${i}.ts`,status:"M" as const,isDeleted:false,rightSideRanges:[{start:1,end:1}]}));
const clean = {status:"completed" as const,blocked_reason:null,findings:[],summary:"Inspected the requested paths; no actionable defects found."};
const invocation: CodexRunnerOptions = {worktreePath:"/snapshot",schemaPath:"/trusted/schema",instructionsPath:"/trusted/instructions",outputPath:"/private/output",model:"gpt-6.1-sol",reasoningEffort:"medium",agentThreads:1,prompt:"Full inventory is replaced for grouped inspections",timeoutMs:1000};
function setup() {
  const data = new Map<string,string>();
  const io = {read:vi.fn(async(file:string)=>data.get(file)),write:vi.fn(async(file:string,text:string)=>{data.set(file,text)})};
  const store = new DiskReviewCheckpointStore("/private/checkpoints",io);
  return {data,io,store,options:{invocation,files,store,taskPrompt:"Frozen comparison and head SHAs",identity:"immutable-scope-and-policy",batchFiles:2}};
}

describe("resumable sequential review",()=>{
  it("resumes after quota exhaustion without repeating completed groups or publishing a partial review",async()=>{
    const s=setup();const calls:string[][]=[];let limited=true;
    const execute=vi.fn(async(o:CodexRunnerOptions)=>{calls.push([...o.expectedPaths!]);if(limited&&o.expectedPaths![0]==="file2.ts")throw new ModelUsageLimitError(Date.now()+1000);return clean;});
    await expect(runResumableReview({...s.options,execute})).rejects.toBeInstanceOf(ModelUsageLimitError);
    expect(s.data.size).toBe(1);limited=false;
    const result=await runResumableReview({...s.options,store:new DiskReviewCheckpointStore("/private/checkpoints",s.io),execute});
    expect(result.status).toBe("completed");expect(result.summary).toContain("5 changed paths in 3 sequential groups");
    expect(calls).toEqual([["file0.ts","file1.ts"],["file2.ts","file3.ts"],["file2.ts","file3.ts"],["file4.ts"]]);
    expect(execute.mock.calls[0]![0].prompt).not.toContain("file4.ts");
    expect(execute.mock.calls[0]![0].prompt).toContain("never an unqualified working-tree diff");
  });
  it("does not reuse completed inspections when frozen scope or trusted policy changes",async()=>{
    const s=setup();const execute=vi.fn().mockResolvedValue(clean);
    await runResumableReview({...s.options,execute});await runResumableReview({...s.options,execute});expect(execute).toHaveBeenCalledTimes(3);
    await runResumableReview({...s.options,identity:"new-head-or-policy",execute});expect(execute).toHaveBeenCalledTimes(6);
  });
  it("does not checkpoint a result after cancellation",async()=>{
    const s=setup();const controller=new AbortController();
    const execute=vi.fn(async()=>{controller.abort();return clean;});
    await expect(runResumableReview({...s.options,invocation:{...invocation,signal:controller.signal},execute})).rejects.toThrow();
    expect(s.data.size).toBe(0);expect(execute).toHaveBeenCalledTimes(1);
  });
  it("fails closed on corrupt checkpoints before any model call",async()=>{
    const s=setup();await runResumableReview({...s.options,execute:async()=>clean});
    const key=[...s.data.keys()][0]!;s.data.set(key,'{"private":"corrupt"}');const execute=vi.fn();
    await expect(runResumableReview({...s.options,execute})).rejects.toMatchObject({name:"CodexExecutionError",failureKind:"blocked"});expect(execute).not.toHaveBeenCalled();
  });
  it("rejects findings anchored outside the requested group",async()=>{
    const s=setup();const output={...clean,findings:[{path:"file4.ts",title:"Defect",body:"Concrete defect",priority:1 as const,confidence:0.95,start_line:1,end_line:1}]};
    await expect(runResumableReview({...s.options,execute:async()=>output})).rejects.toMatchObject({failureKind:"blocked"});expect(s.data.size).toBe(0);
  });
  it.each(["0","33","-1","1.5","garbage"])("rejects invalid configured group sizes (%s)",value=>{
    expect(()=>loadReviewBatchFiles({REVIEW_BATCH_FILES:value})).toThrow();
  });
  it("is opt-in and changes shared scheduling policy when enabled",()=>{
    expect(loadReviewBatchFiles({})).toBeUndefined();expect(loadReviewBatchFiles({REVIEW_BATCH_FILES:""})).toBeUndefined();
    expect(loadReviewBatchFiles({REVIEW_BATCH_FILES:"16"})).toBe(16);
    expect(reviewPolicyHash({})).toBe(reviewPolicyHash({REVIEW_BATCH_FILES:""}));
    expect(reviewPolicyHash({})).not.toBe(reviewPolicyHash({REVIEW_BATCH_FILES:"16"}));
  });
  it("binds checkpoints to exact requested paths and validates completed output",async()=>{
    const s=setup(),key="a".repeat(64);await s.store.write(key,["file0.ts"],clean);
    expect(await s.store.read(key,["file0.ts"])).toEqual(clean);
    await expect(s.store.read(key,["file1.ts"])).rejects.toThrow(/scope/);
    const file=[...s.data.keys()][0]!;s.data.set(file,JSON.stringify({key,paths:["file0.ts"],output:{...clean,status:"blocked",blocked_reason:"Unavailable"}}));
    await expect(s.store.read(key,["file0.ts"])).rejects.toThrow();
  });
  it("rejects checkpoint path traversal and oversized output before writing",async()=>{
    const s=setup();await expect(s.store.write("../private",[],clean)).rejects.toThrow(/identity/);
    await expect(s.store.write("a".repeat(64),[],{...clean,summary:"x".repeat(1024*1024)})).rejects.toThrow();expect(s.io.write).not.toHaveBeenCalled();
  });
});
