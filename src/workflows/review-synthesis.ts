import type { ReviewUnit } from "../repositories/review-plan.js";
import { encodeReviewData } from "../repositories/review-plan.js";
import { DiffLimitError } from "../repositories/diff.js";
import type { CompletedReviewOutput, ReviewFinding } from "../validation/review-output.js";

/** All unit identities are represented; only untrusted narrative summaries are shortened. */
export function buildSynthesisContext(records: readonly { unit: ReviewUnit; output: CompletedReviewOutput }[]): string {
  let summaryLength = 512;
  for (;;) {
    const context = encodeReviewData(records.map(({ unit, output }) => ({
      unit: unit.id, ...(unit.chunkId === undefined ? {} : { chunk: unit.chunkId, boundaryPaths: unit.boundaryPaths ?? [], boundaryPathsTruncated: unit.boundaryPathsTruncated ?? false }), paths: unit.files.map(file => file.path), summary: output.summary.slice(0, summaryLength),
      summaryTruncated: output.summary.length > summaryLength,
    })));
    if (Buffer.byteLength(context) <= 48 * 1024) return context;
    if (summaryLength === 0) throw new DiffLimitError("integration inventory exceeds bounded context capacity");
    summaryLength = Math.floor(summaryLength / 2);
  }
}

export function mergeReviewFindings(outputs: readonly CompletedReviewOutput[]): ReviewFinding[] {
  const unique = new Map<string, ReviewFinding>();
  for (const output of outputs) for (const finding of output.findings) unique.set(JSON.stringify(finding), finding);
  return [...unique.values()].sort((a, b) => a.priority - b.priority || b.confidence - a.confidence).slice(0, 50);
}

export function verificationBatches(findings: readonly ReviewFinding[]): ReviewFinding[][] {
  const batches: ReviewFinding[][] = [];
  for (const finding of findings) {
    const current = batches.at(-1);
    if (Buffer.byteLength(encodeReviewData([finding])) > 24 * 1024)
      throw new DiffLimitError("candidate exceeds bounded verification capacity");
    if (current && Buffer.byteLength(encodeReviewData([...current, finding])) <= 24 * 1024) current.push(finding);
    else batches.push([finding]);
  }
  return batches;
}
