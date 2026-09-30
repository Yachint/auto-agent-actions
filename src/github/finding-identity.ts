import { createHash } from "node:crypto";
import type { ReviewFinding } from "../validation/review-output.js";

/** Excludes line offsets and confidence so relocation does not change the causal identity. */
export function findingIdentity(finding: ReviewFinding): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        finding.path,
        finding.title.trim().toLowerCase(),
        finding.body.replace(/\s+/g, " ").trim(),
      ]),
    )
    .digest("hex");
}
