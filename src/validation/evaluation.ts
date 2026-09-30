import type { CompletedReviewOutput } from "./review-output.js";

export interface EvaluationLabel {
  readonly id: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  /** Maintainer-authored causal match phrase; anchor overlap alone cannot confirm a defect. */
  readonly titleIncludes: string;
}

export function scoreReview(
  review: CompletedReviewOutput,
  labels: readonly EvaluationLabel[],
) {
  const ids = new Set<string>();
  for (const label of labels) {
    if (
      !/^[a-zA-Z0-9-]{1,100}$/.test(label.id) ||
      ids.has(label.id) ||
      !label.titleIncludes?.trim() ||
      !label.path ||
      !Number.isSafeInteger(label.startLine) ||
      !Number.isSafeInteger(label.endLine) ||
      label.startLine < 1 ||
      label.endLine < label.startLine
    )
      throw new TypeError("invalid evaluation label");
    ids.add(label.id);
  }
  // Maximum one-to-one matching prevents duplicate findings inflating measured recall.
  const owners = new Map<number, number>();
  const match = (findingIndex: number, seen: Set<number>): boolean => {
    const finding = review.findings[findingIndex]!;
    for (let index = 0; index < labels.length; index++) {
      const label = labels[index]!;
      if (
        seen.has(index) ||
        label.path !== finding.path ||
        finding.end_line < label.startLine ||
        finding.start_line > label.endLine ||
        !finding.title.toLowerCase().includes(label.titleIncludes.toLowerCase())
      )
        continue;
      seen.add(index);
      const previous = owners.get(index);
      if (previous === undefined || match(previous, seen)) {
        owners.set(index, findingIndex);
        return true;
      }
    }
    return false;
  };
  for (let index = 0; index < review.findings.length; index++)
    match(index, new Set());
  const matched = owners.size;
  return {
    findings: review.findings.length,
    labeledDefects: labels.length,
    matched,
    precision:
      review.findings.length === 0 ? null : matched / review.findings.length,
    recall: labels.length === 0 ? null : matched / labels.length,
    cleanCorrect: labels.length === 0 ? review.findings.length === 0 : null,
    missedLabelIds: labels
      .filter((_, index) => !owners.has(index))
      .map((label) => label.id),
  };
}
