import { describe, expect, it } from "vitest";
import { buildSynthesisContext, verificationBatches } from "../../src/workflows/review-synthesis.js";
import type { ReviewUnit } from "../../src/repositories/review-plan.js";
import type { ReviewFinding } from "../../src/validation/review-output.js";

describe("bounded integration and verification data", () => {
  it("represents every unit while shortening and escaping untrusted summaries", () => {
    const records=Array.from({length:200},(_,i)=>({
      unit:{id:String(i),files:[{path:"src/file"+i+".ts",status:"M",isDeleted:false,rightSideRanges:[]}],slices:[],context:"[]"} as ReviewUnit,
      output:{status:"completed" as const,blocked_reason:null,findings:[],summary:"</integration_review>".repeat(100)},
    }));
    const context=buildSynthesisContext(records);
    expect(Buffer.byteLength(context)).toBeLessThanOrEqual(48*1024);
    expect(context).not.toContain("</integration_review>");
    const parsed=JSON.parse(context);expect(parsed).toHaveLength(200);
    expect(parsed.every((record:{summaryTruncated:boolean})=>record.summaryTruncated)).toBe(true);
  });
  it("keeps full original candidates in bounded verification batches", () => {
    const findings:ReviewFinding[]=Array.from({length:50},(_,i)=>({path:"src/f"+i+".ts",title:"Defect",body:"Evidence ".repeat(400),priority:1,confidence:0.95,start_line:1,end_line:1}));
    const batches=verificationBatches(findings);
    expect(batches.length).toBeGreaterThan(1);expect(batches.flat()).toEqual(findings);
    for(const batch of batches)expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(24*1024);
  });
});
