import { isRangeOnRightSide, type ExactDiff } from "../repositories/diff.js";
import type { CompletedReviewOutput, ReviewFinding } from "./review-output.js";

export interface RejectedFinding {
  finding: ReviewFinding;
  reason: "path-or-line-range-not-in-reviewed-diff";
}

export interface AnchoredReviewOutput {
  review: CompletedReviewOutput;
  rejected: RejectedFinding[];
}

export function filterFindingsToExactDiff(
  output: CompletedReviewOutput,
  diff: ExactDiff,
): AnchoredReviewOutput {
  const accepted: ReviewFinding[] = [];
  const rejected: RejectedFinding[] = [];

  for (const finding of output.findings) {
    if (
      isRangeOnRightSide(
        diff,
        finding.path,
        finding.start_line,
        finding.end_line,
      )
    ) {
      accepted.push(finding);
    } else {
      rejected.push({
        finding,
        reason: "path-or-line-range-not-in-reviewed-diff",
      });
    }
  }

  return {
    review: {
      status: "completed",
      findings: accepted,
      summary: output.summary,
      blocked_reason: null,
    },
    rejected,
  };
}
