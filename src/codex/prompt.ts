export interface ReviewPromptInput {
  repository: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
}

const REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const FULL_GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export function buildReviewPrompt(input: ReviewPromptInput): string {
  validatePromptInput(input);

  const baseSha = input.baseSha.toLowerCase();
  const headSha = input.headSha.toLowerCase();

  return `<review_task>
<objective>Review the changes introduced by this pull request and report only verified, actionable defects.</objective>

<trusted_metadata>
Repository: ${input.repository}
Pull request: #${input.pullRequestNumber}
Base SHA: ${baseSha}
Head SHA: ${headSha}
</trusted_metadata>

<exact_scope>
Review only the changes between the exact base and head SHAs above. Begin with the right-hand side of \`git diff ${baseSha} ${headSha}\`. Inspect surrounding repository code only as needed to trace the behavior of changed lines. Do not substitute a branch tip, merge base, or different commit.
</exact_scope>

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
