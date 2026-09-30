# Project review — 2026-09-30

Reviewed revision: `090063a918675fc8286e8c651fd2904811bf4467`.

This is an assessment and proposed roadmap. It does not change runtime behavior or adopt a new model, authentication method, publication policy, or infrastructure dependency.

## Assessment

Substantial improvements are possible. The existing separation between webhook intake, analysis, token brokering, validation, and publication is worth preserving. The immediate priority is reliable lifecycle handling and correct review scope. A newer model cannot compensate for reviewing the wrong diff, losing the newest job, or failing to publish a completed result.

The latest checked-in update is September 2, 2026, about four weeks ago. This is a working service with recent hardening and a recorded production canary, rather than an abandoned prototype. Its main gaps are coordination between independently durable stages, empirical review evaluation, and operations automation.

Strengths include strict TypeScript, injected external boundaries, signed raw-body webhooks, selected-repository access, separate read/write installation tokens, a publisher-only App key, bounded structured output, explicit blocked reviews, anchor filtering, and an actual sandbox write-denial startup probe. The review instructions already require causal evidence, candidate disproof, and bounded conditional delegation. Adding those principles again would provide little value.

## Verification and limits

| Check | Result |
| --- | --- |
| `npm run build` | Passed; both trusted static assets match their copies in `dist` |
| `npm test` | 144 passed; one Unix-socket test skipped by default |
| Opt-in Unix-socket integration test | Passed separately with `RUN_UNIX_SOCKET_TEST=1` |
| Production dependency audit | Two affected package entries: high-severity `fast-uri`, moderate-severity `fastify` |
| Full dependency audit | Four affected package entries: the above plus moderate-severity `vitest` and `@vitest/mocker` |
| Synthetic Git and workflow reproductions | Reproduced the scope, pathspec, handoff, enqueue-crash, eligibility, duplicate-publication, rejected-anchor, timeout, and historical-replay failures described below |
| Real Redis/BullMQ reproduction | Confirmed duplicate same-head starts and failed-publication retention blocking recovery |
| Local Codex 0.159.2 candidate | Help compatibility passed; actual sandbox preflight failed |

Tests ran locally on Node 26.5.1. The deployed Dockerfile targets Node 24; a full production image build, live VPS validation, live GitHub publication, and model-quality benchmark were not performed. GitHub clients were faked in workflow reproductions. Redis used a disposable container with networking disabled and a temporary Unix socket; it and the temporary fixtures were removed. No production credentials or private review content were inspected.

## Confirmed defects and failure paths

### F01 — P1: review scope does not match GitHub's PR diff

Locations: [`src/repositories/diff.ts`](../src/repositories/diff.ts), lines 89–136; [`src/codex/prompt.ts`](../src/codex/prompt.ts), line 29.

The implementation compares the captured base tip directly to the head. The prompt explicitly prohibits substituting a merge base. When `main` advances independently of a topic branch, this includes base-only changes as apparent PR changes. GitHub's PR view uses the merge base to head comparison. [GitHub diff semantics](https://docs.github.com/en/pull-requests/reference/branches#three-dot-and-two-dot-git-diff-comparisons).

A synthetic diverged history produced `base-only.txt` and `topic.txt` in the service diff, but only `topic.txt` in the three-dot diff. Consequences include false findings, incorrect anchors, and publication rejection.

Compute and freeze the merge-base SHA from the captured base/head pair. Preserve the base tip separately for provenance. Give the same immutable merge-base/head scope to the prompt, validator, and publisher. Fail closed on missing or ambiguous comparison information. This requires an explicit correction to the product plan and prompt contract, not only a parser patch.

### F02 — P1: retained failed publication jobs prevent recovery

Location: [`src/queue/publication-queue.ts`](../src/queue/publication-queue.ts), lines 65–79.

The publication job ID hashes repository, PR number, and head. Failed jobs are retained for up to 30 days, subject to the count limit. Reconciliation can rerun analysis with a fresh delivery ID, but publication reuses the old ID. BullMQ ignores an insertion with an existing ID. [BullMQ job IDs](https://docs.bullmq.io/guide/jobs/job-ids).

With real Redis/BullMQ, publication failed all three attempts. Re-enqueueing a new result left one failed job, zero waiting jobs, and the original payload. Review state remained `running`, and requesting the same head returned false. Normal reconciliation no longer rescued it.

Recover publication explicitly: retry the retained failed job when its artifact remains valid, or create a generation-specific replacement under an atomic publication claim. A retained job must not be mistaken for successfully scheduled work. Recovering a publication outage should normally reuse a validated analysis artifact rather than spend another model run.

### F03 — P1: a new head can be lost during publication handoff

Locations: [`src/workflows/analysis-job.ts`](../src/workflows/analysis-job.ts), lines 59–64 and 125–130; [`src/queue/redis-review-state.ts`](../src/queue/redis-review-state.ts), lines 129–155; [`src/workflows/publication-job.ts`](../src/workflows/publication-job.ts), lines 54–66.

Analysis leaves head A as `currentlyRunningHeadSha` after handoff, even though its BullMQ analysis job completes. If head B arrives while A awaits publication, B's analysis job can run before the publisher clears A. `tryStart(B)` refuses because A is still running, and the processor treats that refusal as terminal supersession. The publisher then discards A and clears the running field. State says B is queued, but B's job has already been consumed. Requesting B again returns false.

A direct processor/state reproduction reached exactly that stuck state. Distinguish a busy lease from a stale generation. Track analysis and publication separately, or explicitly reschedule the latest head when the blocking stage releases ownership. A current request must never be acknowledged as superseded merely because another stage owns a lease.

### F04 — P1: a crash between state persistence and queue insertion loses work

Locations: [`src/queue/bullmq-review-queue.ts`](../src/queue/bullmq-review-queue.ts), lines 45–58; [`src/queue/redis-review-state.ts`](../src/queue/redis-review-state.ts), lines 129–142.

`recordRequested` persists `queued` before `Queue.add`. The catch path handles a thrown insertion error, but a process crash between those operations cannot execute it. A later request for the same head sees a nonfailed state and skips insertion, including reconciliation.

Reproducing the state immediately before insertion yielded zero new jobs on retry. Persist scheduling intent in a repairable outbox, or make reconciliation inspect whether a corresponding job/artifact/lease actually exists. Timestamp-only state without ownership or expiration is insufficient. Apply the same principle to analysis-to-publication handoff and terminal failure handling.

### F05 — P2: ineligible PRs are recorded as successfully reviewed

Locations: [`src/workflows/analysis-job.ts`](../src/workflows/analysis-job.ts), lines 79–86; [`src/workflows/publication-job.ts`](../src/workflows/publication-job.ts), lines 97–104.

If an eligible queued PR becomes draft or closed before processing, analysis calls `complete`, recording its head as reviewed despite doing no review. Marking it ready or reopening it without another commit then gets suppressed. Publisher-side ineligibility also completes state without posting the analyzed result.

A draft-then-ready simulation returned `ineligible`, then refused to queue that same head. Introduce a distinct ineligible/deferred outcome and release ownership without claiming successful delivery. Eligibility transitions should be able to retry an unchanged, unhandled head.

### F06 — P2: successful GitHub writes can be duplicated on retry

Locations: [`src/github/publisher.ts`](../src/github/publisher.ts), lines 88–101; [`src/workflows/publication-job.ts`](../src/workflows/publication-job.ts), lines 77–101; [`src/github/client.ts`](../src/github/client.ts), lines 162–175.

A review can be accepted by GitHub before the response is lost or the subsequent Redis completion write fails. The retry performs another POST. Summary markers exist, but no client operation reads prior reviews to recover an already accepted write.

Injecting a state-write failure after successful publication produced two reviews for one head. Persist publication identity and review ID, and recover ambiguous writes by listing App-authored reviews and matching a trusted marker plus commit. Serialize publication per identity. Redis and GitHub do not share a transaction, so do not promise absolute exactly-once writes under every network failure.

Failure notifications also need generation/state checks: an old notification for an unchanged head currently can post after a newer attempt has succeeded, because the failure path checks GitHub eligibility but not whether that attempt is still relevant.

### F07 — P1: retargeting the base is invisible to review identity

Locations: [`src/queue/review-state.ts`](../src/queue/review-state.ts); [`src/github/client.ts`](../src/github/client.ts), `GitHubPullRequestState`; [`src/github/publisher.ts`](../src/github/publisher.ts), lines 68–78; [`src/github/webhook.ts`](../src/github/webhook.ts), supported actions.

State identifies work by head alone. Publication does not retrieve or compare the base branch/SHA, and `edited` base changes are unsupported. Retargeting a PR during analysis can publish a result for the old comparison. Retargeting an already reviewed PR without changing its head suppresses further review, including reconciliation.

This follows directly from the stored identity and publisher interface; it was not tested against live GitHub. Include base repository/ref and frozen comparison scope in review identity. Support relevant base edits and detect them during reconciliation. Decide explicitly whether advancing a base tip with an unchanged merge base warrants reevaluation; avoid unnecessary reanalysis when the reviewed patch is unchanged.

### F08 — P2: repository filenames are interpreted as Git pathspecs

Location: [`src/repositories/diff.ts`](../src/repositories/diff.ts), lines 118–136.

Passing a filename after `--` prevents option injection but does not make it literal. A changed filename such as `*.txt` matches other paths. The parser then assigns all returned hunk ranges to that one file.

A one-line `*.txt` file changed at line 1 incorrectly acquired a line-70 range from `other.txt`. Use Git's global `--literal-pathspecs` option or equivalent literal pathspec encoding, including previous paths for renames. Add real Git cases for wildcards, brackets, colon-prefixed names, and renames.

### F09 — P2: rejected findings can become a false clean conclusion

Locations: [`src/workflows/review-core.ts`](../src/workflows/review-core.ts), anchored result; [`src/workflows/analysis-job.ts`](../src/workflows/analysis-job.ts), lines 125–128; [`src/github/publisher.ts`](../src/github/publisher.ts), lines 83–86.

The local workflow exposes rejected findings, but production drops that information at handoff. If every candidate has an invalid anchor, the publisher says no actionable issues were found. A synthetic wrong-path candidate produced that clean statement.

Keep genuine zero-finding output distinct from rejected candidates, confidence filtering, and incomplete coverage. Preserve sanitized rejection counts/reasons through publication. An invalid anchor must remain unpublished; it can trigger bounded reanchoring or a neutral validation-failure outcome, never an invented safe line or a stronger clean claim.

### F10 — P2: the timeout does not terminate the process tree

Location: [`src/codex/runner.ts`](../src/codex/runner.ts), lines 278–345.

Termination targets only the direct child. A descendant holding inherited output pipes delays the `close` event after that child dies. A synthetic 100 ms timeout took approximately 1.56 seconds because its descendant stayed alive; an unbounded descendant can hold the slot much longer. This is relevant to shell commands and the enabled subagent workflow.

Terminate a dedicated process group or per-job container/cgroup, bound settlement after termination, and verify descendants are gone. Add cancellation for superseded reviews and a bounded shutdown path. Compose's default shutdown grace can otherwise kill the worker while its asynchronous close waits for a long review.

### F11 — P2: retry scheduling ignores GitHub rate-limit guidance

Locations: [`src/github/client.ts`](../src/github/client.ts), lines 178–198; both queue retry configurations; publisher concurrency in [`compose.yaml`](../compose.yaml).

The client retains status but discards rate-limit headers. Every queue failure follows the same one-second exponential backoff, and publication concurrency defaults to five. GitHub asks integrations to honor `Retry-After`, wait for primary-limit reset, or pause at least a minute for other secondary limits. [GitHub API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#handle-rate-limit-errors-appropriately).

Classify authorization, malformed output, limits, transient transport failures, and ambiguous writes separately. Use installation-aware scheduling and bounded jitter. Invalid results should not repeatedly consume model time; an expired account session should pause analysis and alert an operator instead of failing every PR.

### F12 — P2: the proposed evaluation path cannot replay advanced PRs

Locations: [`docs/REVIEW_PROMPT_EVALS.md`](REVIEW_PROMPT_EVALS.md), running a comparison; [`src/repositories/manager.ts`](../src/repositories/manager.ts), lines 73–97.

The evaluation document freezes historical SHAs, but the fixture workflow fetches the current PR head ref and requires it to equal the saved head. After the PR advances, replay fails even when the old object remains available. A synthetic saved-head replay produced `StaleReviewRefError`.

Provide a separate offline snapshot mode for evaluation. Preserve approved immutable Git objects and comparison metadata in private storage, verify their identity, and run the same trusted review/validation core against those snapshots. Keep production's current-head checks intact. The repository currently contains the evaluation protocol and instruction-contract tests, but no executable benchmark/scorer or checked-in sanitized comparison evidence.

## Maintenance and security assessment

### Dependency updates

The September 2 zero-advisory result is historical. Both audit scopes now fail. Installed production copies include `fast-uri` 3.1.6 and 4.1.3; today's audit identifies patched ranges starting at 3.1.8 and 4.1.5 respectively for the reported advisory set. Fastify's current compatible update is 5.12.5; Vitest's compatible update is 4.1.11. These are registry observations on this review date, not an assertion that every advisory is reachable in this application.

Refresh compatible dependencies and the lockfile first, then build/test/audit the resolved tree. BullMQ 5.81.5 is available within the existing range. BullMQ 6, ioredis 6, and Vitest 5 are separate major migrations and should not be mixed into recovery fixes without a compatibility review.

### Codex upgrade requires a real execution gate

Deployment documentation validates 0.151.0. The registry and locally installed CLI reported 0.159.2 during this audit. With an isolated empty credential/config directory, the project's help-based verifier accepted 0.159.2, but `verifyCodexReadOnlySandbox` failed with:

```text
filesystem-restricted execution requires bubblewrap to isolate app-server sockets
```

This is local evidence, not a finding that the current VPS pin is broken. Keep the existing deployment pin until an exact candidate passes real execution on the intended topology. Test configuration parsing, write denial, forbidden file reads, network denial, malicious repository guidance, structured output, descendants, and credential separation. Help text alone cannot certify sandbox compatibility. Do not solve compatibility by weakening the existing sandbox.

### A read-only policy is not a complete confidentiality boundary

The App key remains correctly separated. However, the persistent analysis container also mounts the broker secret/socket, all review mirrors/worktrees, and the Codex account credential directory. Environment filtering does not remove those filesystem resources. The startup probe proves write denial, not restricted read scope, process isolation, or publisher-side verification of diff authenticity.

There is no independent publisher reconstruction of `exactDiff`; it validates the shape and head of an analysis-supplied object. A compromised analysis boundary therefore has more influence than an untrusted model result alone. Treat this as an architecture risk requiring adversarial verification, rather than claiming a tested live credential exploit.

For broader contributors, place each review in an isolated disposable execution environment containing only that job's read-only snapshot and trusted artifacts. Keep queue access, the broker, sibling repositories, and credentials outside it. Use a narrowly authorized model-access proxy and a restricted result channel. Have the publisher establish allowed anchors independently of a forgeable analysis payload. This can remain a Compose/VPS design; mounting the host Docker socket into analysis would undermine the boundary.

OpenAI's current automation guidance favors API keys and advises against account-auth automation for public/open-source repositories. An API key simply substituted into the same readable environment would still need isolation. [OpenAI non-interactive authentication guidance](https://learn.chatgpt.com/docs/non-interactive-mode#authenticate-in-automation).

Also document the unavoidable race between the final GitHub GET and review POST. Explicit `commit_id` preserves the reviewed snapshot, but a later push can occur between those requests. Add detection and recovery for obsolete bot output and test the race rather than describing the last precheck as an atomic guarantee.

## Proposed pipeline improvement

Keep the existing trust boundaries and introduce durable, versioned runs:

```text
Signed intake / authorized re-review / reconciliation
  -> durable requested generation and scheduling outbox
  -> canonical immutable comparison snapshot
  -> isolated analysis with owned expiring lease
  -> candidate verification, coverage and anchor validation
  -> validated artifact plus publication outbox
  -> publisher scope recheck, write recovery and review-ID receipt
```

Record a stable run ID, requested generation, immutable head and comparison SHAs, base repository/ref, policy hash, CLI/model/effort, stage timestamps, owning attempt, lease expiry, artifact identity, and publication receipt. A policy hash should cover the actual prompt template, instructions, schema, and publication settings. Retain only necessary private data with explicit access and retention controls.

Use distinct stage outcomes such as `queued`, `analyzing`, `analysis-complete`, `publication-pending`, `published`, `deferred`, `superseded`, and typed failure. Expiring stage ownership plus a fencing generation prevents a dead or old attempt from completing a newer run. A current generation blocked by another lease remains retryable. Two `tryStart` calls for the same head currently both return true, including under real Redis; a head SHA is not an attempt-owned lease.

Reconciliation should repair inconsistencies, not only enumerate GitHub heads: requested generations without jobs, expired analysis leases, artifacts without publication jobs, failed publications with reusable artifacts, and ambiguous writes without receipts. Redis can still support this; a database migration is not a prerequisite. PostgreSQL becomes useful when searchable run history and a transactional outbox justify the additional service.

## Review quality and author workflow

| Improvement | Concrete implementation direction | Evidence needed to accept it |
| --- | --- | --- |
| Executable evaluation | Private immutable snapshots, maintainer labels, repeated baseline/candidate runs, sanitized score export | Precision, confirmed-defect recall, clean-PR correctness, safety, reliability, latency and usage comparison |
| Candidate verification | A separate bounded read-only pass for complex/high-impact findings, checking guards and causal claims | Fewer confirmed false positives without materially reducing recall |
| Deterministic review inventory | Trusted manifest of changed paths, hunks, file kinds, and diff sizes; model inventory checked against it | No silently omitted changed components; honest binary/generated/deletion-only coverage |
| Adaptive effort | Small coherent PRs use one reviewer; broad/high-risk PRs use bounded parallel investigation and stronger verification | Quality maintained at better latency/usage on labeled PR buckets |
| Safe result reuse | Retry publication from validated artifacts; cancel superseded analysis; reuse unchanged analysis only under matching scope and policy | Fewer wasted runs without stale or cross-policy reuse |
| Authorized re-review | Operator command first, then optional exact comment command with permission checks, cooldown, bot-loop protection and a new generation | Same-head re-review works without empty commits or duplicate publication |
| Severity-aware signaling | Configurable blocking severity rather than requesting changes for every P3; preserve advisory clean outcomes | Authors understand which findings block and how prior bot requests are cleared |
| Visible execution status | GitHub Check Run for queued/running/completed/failed state, separate from review findings | Failed/blocked inspection is visible and never appears as a successful check |
| Finding continuity | Stable root-cause identities with author/maintainer dispositions across heads | Reduced repeated threads while detecting recurrences and avoiding suppression of changed issues |

Checks would require an explicit product decision and `checks: write` permission on the publisher-side token only. Comment commands similarly require expanded subscriptions and authorization. Neither should be added by silently widening App permissions.

Incremental review is useful only with controls: a narrow new-commit pass can miss interactions across the full PR. Start by caching validated preparation and publication artifacts, then evaluate incremental analysis with mandatory full-review fallbacks for changed comparison bases, cross-cutting changes, migrations, security boundaries, and policy updates. Do not treat an unchanged file as evidence that its callers and invariants are unchanged.

Self-reported confidence is a filtering signal, not a demonstrated probability of correctness. Calibrate thresholds using maintainer-labeled outcomes. Large-PR sharding also requires shared global context and final synthesis; splitting only by filename can miss cross-file defects. A verification pass is a proposal to benchmark, not a guaranteed improvement.

## Project development and operations workflow

There is no tracked `.github` CI workflow. Add automatic build, asset checks, unit/integration tests, production Node 24 verification, dependency audit, Compose resolution, and both runtime image builds. Run real Redis/BullMQ recovery/concurrency tests and the socket test in a capable CI environment. CI tests belong to development of this service; reviewed repositories must still never run their own programs or dependency installation.

Introduce scheduled dependency-update proposals and a separate exact-Codex-version canary process. Pin release images by digest, produce a release manifest, and keep rollback instructions. The default model should change only after measured comparison against the current baseline; the audit did not establish which model is best for this workload.

Add worker heartbeats, auth/broker readiness, oldest pending-generation age, queue-wait and end-to-end latency histograms, timeouts, failure classes, expired leases, rejected anchors, dropped/superseded work, publication retries, and finding outcomes. The server readiness endpoint currently checks Redis only, so it can stay healthy while analysis is unable to start. Existing metrics provide totals and queue counts but cannot explain that condition.

Use bounded streaming JSONL processing for usage/completion metadata; do not retain raw messages, commands, diffs, or prompts in logs. Codex documents JSONL events and token usage for non-interactive execution. [OpenAI machine-readable execution output](https://learn.chatgpt.com/docs/non-interactive-mode#make-output-machine-readable).

Schedule safe worktree cleanup and mirror/ref retention rather than running cleanup only at startup. Add disk budgets and Redis memory monitoring; the container memory limit does not itself provide an application-level capacity policy. Rehearse backup restoration with the new run-state/publication-recovery behavior.

Refresh documentation together: `docs/PLAN.md` still contains an earlier COMMENT-only instruction despite its later REQUEST_CHANGES decision; README milestone text predates the recorded live canary; `.env.vps.example` still specifies a ten-minute timeout while the production/default decision says thirty. Preserve historical memory entries, but keep current deployment and product contracts internally consistent.

## Recommended delivery order

| Sequence | Scope | Acceptance gate |
| --- | --- | --- |
| 1. Repair correctness and recovery | F01–F10, compatible security updates, real Redis regression suite | Correct GitHub scope; no lost current heads; recoverable failed publication; safe eligibility transitions; bounded process cleanup; honest outcomes |
| 2. Make upgrades measurable | Immutable replay harness, privacy-safe usage/latency, exact-version sandbox canary, CI | Repeatable baseline; candidate passes safety/contract checks and maintainer-reviewed quality comparison |
| 3. Improve author workflow | Authorized re-review, execution checks, severity policy, finding continuity | Clear status and blocking semantics without additional review spam |
| 4. Expand execution isolation | Per-job environment, model-access proxy, independent publication scope verification | Adversarial tests prove secret/sibling-repository/queue isolation on the intended VPS topology |
| 5. Optimize measured bottlenecks | Adaptive effort, verified candidates, safe reuse, carefully evaluated incremental review | Demonstrated latency/usage gains while preserving the agreed quality and safety thresholds |

The highest-value first implementation is a pipeline reliability change covering canonical diff scope, independent analysis/publication state, repairable scheduling, and publication recovery. Keep prompt/model experiments separate so their effects can be measured.
