# Review trigger reference

Auto Agent Actions reviews a pull request only when its current head commit is eligible and has not already been successfully reviewed. GitHub may deliver many kinds of pull-request activity, but the first release intentionally starts reviews for only the cases below.

## Events that start a review

| Trigger | GitHub event/action | Result |
| --- | --- | --- |
| A non-draft pull request is created | `pull_request.opened` | Reviews the PR's current head. |
| A closed pull request is reopened | `pull_request.reopened` | Reviews the current head if the PR is now open and non-draft. |
| New commits are pushed to the PR branch, including a force-push | `pull_request.synchronize` | Reviews the newest head commit. Any obsolete in-progress result is prevented from publishing. |
| A draft PR is marked ready for review | `pull_request.ready_for_review` | Reviews the current head. Draft PRs themselves are not reviewed. |
| A supported webhook was missed during downtime | Scheduled reconciliation | At publisher startup and every `RECONCILIATION_INTERVAL_MS` (15 minutes by default), scans allowlisted repositories for eligible open PR heads and queues any head not already handled. |

Every case must also pass all eligibility checks: the repository is installed and allowlisted, the PR is open and non-draft, the head and base belong to the same repository, and the head SHA is valid. Forked PRs are not supported in the first release.

GitHub describes `opened`, `reopened`, `synchronize`, and `ready_for_review` as activity types of the `pull_request` event. See [GitHub webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads).

## What appears after a successful review

- If publishable findings exist, the App posts one advisory `COMMENT` review with validated inline comments and a summary.
- If no actionable findings are returned, the App still posts a summary-only `COMMENT` stating that the review completed, that no actionable issues were found, and what areas were reviewed.
- If candidate findings exist but none meet the configured confidence threshold, the summary-only comment says that no findings met the publication threshold.
- Closed, draft, forked, or stale-head results never post. A stale result schedules the newest head instead.

Summary-only comments are enabled by default with `REVIEW_PUBLISH_SUMMARY_WITHOUT_FINDINGS=true`. Redis head-SHA state prevents reconciliation or redelivery from posting the same review repeatedly for an unchanged head.

## Events that do not start a review

The following do not request a review or re-review:

- A normal PR conversation comment, including messages such as `please re-review` or `@Agent-Auto-Review re-review`.
- An inline review comment, submitted review, approval, requested changes, review dismissal, or resolved/unresolved review thread.
- Editing the PR title or description.
- Adding or removing labels, assignees, milestones, or requested reviewers.
- Closing or merging the PR.
- Converting a PR back to draft.
- A push that does not update an eligible open pull request.
- Repeated reconciliation of the same unchanged, successfully handled head SHA.

GitHub represents PR conversation comments with `issue_comment`, while reviews, inline comments, and threads use separate review events. The App does not subscribe to those events. See [GitHub's `issue_comment` documentation](https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment).

Signed GitHub App `ping`, `installation`, and `installation_repositories` lifecycle deliveries receive HTTP 200 for connectivity and lifecycle acknowledgement, but never queue review work.

## How to request a re-review today

Push another commit to the PR branch. A changed head SHA produces `pull_request.synchronize` and requests a new review. If no file change is needed, an empty commit also changes the head SHA:

```bash
git commit --allow-empty -m "chore: request automated re-review"
git push
```

The reviewer analyzes the complete current PR diff, not only the last commit. Rapid pushes are coalesced to the newest requested head. If a new head arrives while analysis is running, the old result cannot publish and the newest head is scheduled next.

Comment-command re-review is future scope. Adding it safely would require subscribing to `issue_comment`, authenticating the commenter, defining an exact command, preventing bot loops and abuse, and preserving the same head-SHA idempotency and stale-result checks.
