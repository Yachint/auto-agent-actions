# Review trigger reference

Auto Agent Actions reviews a pull request only when its current head/base/policy scope is eligible and has not already been successfully reviewed. GitHub may deliver many kinds of pull-request activity, but the first release intentionally starts reviews for only the cases below.

## Events that start a review

| Trigger | GitHub event/action | Result |
| --- | --- | --- |
| A non-draft pull request is created | `pull_request.opened` | Reviews the PR's current head. |
| A closed pull request is reopened | `pull_request.reopened` | Reviews the current head if the PR is now open and non-draft. |
| New commits are pushed to the PR branch, including a force-push | `pull_request.synchronize` | Reviews the newest head commit. Any obsolete in-progress result is prevented from publishing. |
| A draft PR is marked ready for review | `pull_request.ready_for_review` | Reviews the current head. Draft PRs themselves are not reviewed. |
| The PR base is retargeted or updated | `pull_request.edited` / reconciliation | Reviews the changed base/head scope. |
| A supported webhook was missed during downtime | Scheduled reconciliation | At publisher startup and every `RECONCILIATION_INTERVAL_MS` (15 minutes by default), scans allowlisted repositories for eligible open PR heads and queues any head not already handled. |

If all bounded analysis attempts fail, the publisher posts one sanitized summary-only review for the current head stating that no review conclusion was produced. Failed heads remain eligible for a later reconciliation attempt; each reconciliation run uses a fresh queue delivery identity so a retained failed BullMQ job cannot suppress recovery.

The analysis timeout is controlled by `CODEX_TIMEOUT_MS` and defaults to 30 minutes. A timeout is a failed review, never a successful no-finding outcome.

Every case must also pass all eligibility checks: the repository is installed and allowlisted, the PR is open and non-draft, the head and base belong to the same repository, and the head SHA is valid. Forked PRs are not supported in the first release.

GitHub describes `opened`, `reopened`, `synchronize`, and `ready_for_review` as activity types of the `pull_request` event. See [GitHub webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads).

## What appears after a successful review

- If publishable P0/P1 findings exist, the App posts one `REQUEST_CHANGES` review with validated inline comments and a summary. This changes the pull request's review state and can trigger automation that listens for requested changes.
- If no actionable findings are returned, the App still posts a summary-only `COMMENT` stating that the review completed, that no actionable issues were found, and what areas were reviewed.
- If candidate findings exist but none meet the configured confidence threshold, the summary-only comment says that no findings met the publication threshold.
- If Codex cannot inspect the exact diff, it returns a blocked result. The analysis job fails and no review is published; a blocked inspection is never described as “no issues found.”
- Closed, draft, forked, or stale-head results never post. A stale result schedules the newest head instead.

Summary-only comments are enabled by default with `REVIEW_PUBLISH_SUMMARY_WITHOUT_FINDINGS=true`. Redis head-SHA state prevents reconciliation or redelivery from posting the same review repeatedly for an unchanged head.

A clean summary remains a `COMMENT`, not an `APPROVE` review. If repository rules make a prior changes-requested review merge-blocking, clearing that merge block requires an approval or a configured stale-review dismissal policy; this service does not approve pull requests.

## Events that do not start a review

The following do not request a review or re-review:

- A normal PR conversation comment, including messages such as `please re-review` or `@Agent-Auto-Review re-review`.
- An inline review comment, submitted review, approval, requested changes, review dismissal, or resolved/unresolved review thread.
- Editing the PR title or description while the review scope stays unchanged.
- Adding or removing labels, assignees, milestones, or requested reviewers.
- Closing or merging the PR.
- Converting a PR back to draft.
- A push that does not update an eligible open pull request.
- Repeated reconciliation of the same unchanged, successfully handled head SHA.

GitHub represents PR conversation comments with `issue_comment`, while reviews, inline comments, and threads use separate review events. Comment commands require an explicit optional `issue_comment` subscription. See [GitHub's `issue_comment` documentation](https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment).

Signed GitHub App `ping`, `installation`, and `installation_repositories` lifecycle deliveries receive HTTP 200 for connectivity and lifecycle acknowledgement, but never queue review work.

## Requesting a same-head re-review

Operators can use `npm run review:rereview -- owner/repository PR INSTALLATION HEAD_SHA BASE_BRANCH BASE_SHA` with the service policy environment, Redis URL and allowlist. It assigns a forced-run nonce; reconciliation retains that generation.

Optionally enable `REVIEW_ENABLE_COMMENT_COMMANDS=true` and subscribe the App to `issue_comment`. An exact `/codex-review` conversation comment from a human with current write/maintain/admin repository permission requests a run. The publisher refetches the actual comment, its age, permissions and current PR scope, and enforces a ten-minute per-PR cooldown. Normal comments, bots and unauthorized authors do not request work. Inline review comments do not trigger commands.

Pushing a new commit remains supported. Every run reviews the full merge-base-to-head PR diff. Read [the pipeline update guide](PIPELINE_V2.md) for optional Checks, finding continuity and deployment migration.
