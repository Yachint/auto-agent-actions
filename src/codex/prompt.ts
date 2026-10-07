export interface ReviewPromptInput {
  repository: string;
  pullRequestNumber: number;
  baseSha: string;
  mergeBaseSha?: string;
  headSha: string;
}

const REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const FULL_GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export function buildReviewPrompt(input: ReviewPromptInput): string {
  validatePromptInput(input);

  const baseSha = input.baseSha.toLowerCase();
  const headSha = input.headSha.toLowerCase();
  const comparisonSha = (input.mergeBaseSha ?? input.baseSha).toLowerCase();
  if (!FULL_GIT_SHA_PATTERN.test(comparisonSha))
    throw new TypeError("invalid merge base SHA");

  return `<review_task>
<objective>Review the changes introduced by this pull request and report only verified, actionable defects.</objective>

<trusted_metadata>
Repository: ${input.repository}
Pull request: #${input.pullRequestNumber}
Base SHA: ${baseSha}
Head SHA: ${headSha}
Comparison SHA (frozen merge base): ${comparisonSha}
</trusted_metadata>

<exact_scope>
Review only the changes between the frozen comparison SHA and head SHA above. Use the trusted changed-path inventory, then inspect the right-hand side of \`git diff ${comparisonSha} ${headSha}\` in small groups of literal paths. The base tip is provenance, not the comparison start. Inspect surrounding repository code only as needed to trace the behavior of changed lines. Do not substitute a branch tip or different commit. Use literal Git pathspecs when inspecting repository filenames. When tool output is truncated, narrow the paths or paginate the output and continue inspection; a bounded tool response alone is not a blocker.
</exact_scope>

<inspection_efficiency>
Inspect the supplied patch slices first, then only directly relevant frozen surrounding ranges. Normally use max_output_tokens of 2000 on exec_command; batch related narrow reads to reduce model round trips and paginate only when needed. Avoid whole-file dumps and rereading supplied patches. Finish once the assigned changed behavior and its direct guards/callers are understood. Preserve complete assigned coverage and the finding gate; the parent records whole-path completion only after every assigned slice is inspected.
</inspection_efficiency>

<completion>
Follow the trusted review instructions and return only the JSON object required by the supplied output schema.
</completion>
</review_task>`;
}

function validatePromptInput(input: ReviewPromptInput): void {
  if (!REPOSITORY_PATTERN.test(input.repository)) {
    throw new TypeError("repository must use the owner/name format");
  }

  if (
    !Number.isSafeInteger(input.pullRequestNumber) ||
    input.pullRequestNumber < 1
  ) {
    throw new TypeError("pullRequestNumber must be a positive integer");
  }

  if (!FULL_GIT_SHA_PATTERN.test(input.baseSha)) {
    throw new TypeError("baseSha must be a full Git object ID");
  }

  if (!FULL_GIT_SHA_PATTERN.test(input.headSha)) {
    throw new TypeError("headSha must be a full Git object ID");
  }

  if (input.baseSha.toLowerCase() === input.headSha.toLowerCase()) {
    throw new TypeError("baseSha and headSha must be different");
  }
}
