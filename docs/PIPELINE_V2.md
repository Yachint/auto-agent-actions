# September 2026 pipeline update

This document describes the implemented update; `PROJECT_REVIEW_2026-09-30.md` preserves the original findings. Changes have been tested locally, without deploying or calling the private GitHub App or a live model.

## Correctness and recovery

Reviews compare the unique merge base of the captured base tip and head against the head, matching GitHub's three-dot comparison. The base tip remains provenance. Git paths are literal; external diff helpers and text conversion are disabled. Publisher-side GitHub file patches independently restrict right-side anchors. Missing or truncated patches can suppress findings; rejected candidates cannot produce a clean conclusion.

A review scope hashes head, base branch, base tip, trusted policy and an optional forced-run nonce. Retargets, policy changes and authorized re-reviews create a new scope. Existing Redis field names ending in `HeadSha` retain compatibility at the storage level but now hold scope identities; `schedulingRequest` contains actual GitHub SHAs.

Scheduling intent and validated publication artifacts are durable Redis state. Queue reconciliation repairs missing jobs and retained failed jobs. Analysis uses owner-fenced attempts and renewing leases, releases ownership at handoff, cancels superseded work and recovers expired ownership. Publication has a separate per-PR renewable lease and checks state before writes. The publisher verifies the installation owns the allowlisted full repository name before issuing tokens.

GitHub publication records a stable scope marker after any continuity links and verifies the App bot identity when recovering an ambiguous POST. The privileged App auth provider obtains public App identity through JWT-authenticated `GET /app`; installation-token clients receive only that public identity. Redis keeps the returned review ID. Before a blocking POST, the publisher writes a metadata-only intent journal that survives analysis scope replacement. A per-PR leased repair pass runs every 30 seconds, discovers the exact App-owned review by head and marker, and retries dismissal of obsolete blocking reviews after a lost POST response, failed post-write check or failed dismissal. API errors retain intents; intents with no corresponding review are removed only after a successful lookup seven days later. GitHub cannot atomically compare the branch and create a review: the publisher checks before and after posting and dismisses its blocking review if the scope moved. A small API race remains; live acceptance must exercise it.

P0/P1 findings request changes by default. P2/P3 findings are advisory comments. Set `REVIEW_BLOCKING_PRIORITY=0..3` to change the blocking cutoff. Invalid anchors, confidence filtering, blocked inspection and clean results have distinct summaries. Codex must report inspection coverage for every changed path; missing or uninspectable paths fail analysis. This is a completeness declaration, not proof of model understanding.

## Codex version and job isolation

Pin **0.155.1**. Both 0.155.1 and the current 0.159.2 were checked locally. The former passes the existing hardened read-only Landlock preflight; the latter requires additional socket isolation that fails in the current container topology. The [official changelog](https://learn.chatgpt.com/docs/changelog) documents the newer sandbox changes. Reconsider the pin only after the CLI probe, container preflight and isolated tool canary pass for a candidate version. The owner-selected default is `gpt-6.1-sol` with high reasoning effort. Keep adaptive effort disabled to use high effort consistently; private evaluations remain required before claiming improved review quality.

`REVIEW_ISOLATE_CODEX=true` uses an outer native Landlock/seccomp boundary and a standalone job snapshot. It requires Linux Landlock ABI 4 or later and fails closed. The child cannot read sibling repository contents, mounted account credentials, Redis or the read-token broker; TCP connections are restricted to a per-job model proxy port; UDP, raw, VM and Unix sockets are denied. Landlock restricts the port, not the destination address: a remote listener on that same port remains reachable if container egress permits it. Host egress rules remain required before public-repository use. The parent retains upstream credentials and permits only Responses requests for the configured model. The child receives an expiring proxy capability. Repository-controlled agent guidance is disabled. Directory listing permission is required for the legacy nested sandbox; filesystem names and metadata are not a confidentiality boundary.

The proxy accepts API-key credentials or the access token/account ID in trusted `CODEX_HOME/auth.json`. It does not refresh account OAuth tokens. A 401/403 opens a five-minute analysis pause and readiness failure; renew credentials on the trusted host. Account endpoint compatibility and renewal still require a live owner canary. The synthetic canary uses a fake upstream and spends no model tokens.

Timeouts signal the process group, force termination, bound pipe draining and cancel upstream requests. This is not a cgroup/container per job: a child that deliberately creates a new session can outlive group termination. Container PID/memory/CPU limits remain required. No reviewed project programs, tests or dependency scripts may be run.

## Optional review features

All quality/product features below are off by default:

| Setting | Behavior |
| --- | --- |
| `REVIEW_ADAPTIVE_EFFORT=true` | Smaller ordinary changes use medium effort and one agent; risky paths/large changes receive more effort. Benchmark first. |
| `REVIEW_VERIFY_FINDINGS=true` | A second read-only pass validates candidates; it cannot introduce new finding identities. Additional latency and model cost. |
| `REVIEW_FINDING_CONTINUITY=true` | Repeated unresolved findings link to existing App threads instead of duplicating inline comments. Identity uses normalized path/title/body, so wording changes can still create duplicates. |
| `REVIEW_ENABLE_CHECKS=true` | App-owned Check Runs expose queued, running and completed outcomes. Add Checks write permission to the App and reinstall/update permissions first. |
| `REVIEW_ENABLE_COMMENT_COMMANDS=true` | Subscribe to `issue_comment`; exact `/codex-review` from a human with current write/maintain/admin access schedules a forced run. The privileged publisher refetches the comment and permission, rejects old/bot commands and applies a ten-minute per-PR cooldown. |

Without comment commands, operators can request a same-head run with the same policy environment as the services:

```bash
npm run review:rereview -- owner/repository 123 456 HEAD_SHA main BASE_SHA
```

Set `REDIS_URL` and `GITHUB_ALLOWED_REPOSITORIES`. Analysis refetches current GitHub scope before review. Commands never publish directly.

## Immutable evaluation

Local review accepts `--snapshot /private/case.bundle`; it imports frozen snapshot refs instead of fetching the live PR. Create a trusted bundle with refs named `refs/auto-agent-actions/snapshot/base` and `refs/auto-agent-actions/snapshot/head` pointing at the fixture SHAs. Keep bundles, fixture metadata and labels outside this repository and out of logs.

```bash
npm run review:evaluate -- /private/manifest.json /private/metrics.json
```

Manifest shape:

```json
{
  "model": "gpt-6.1-sol", "reasoningEffort": "high", "repetitions": 3,
  "verifyFindings": false, "adaptiveEffort": false,
  "cases": [{"id": "case-001", "fixture": "case.json", "bundle": "case.bundle",
    "sha256": "BUNDLE_SHA256", "labels": [{"id": "bug-001", "path": "src/file.ts",
      "startLine": 10, "endLine": 12, "titleIncludes": "maintainer-authored causal phrase"}]}]
}
```

Check the precise label fields in `src/validation/evaluation.ts` before authoring a corpus. Reports contain case IDs, counts, scores, duration and token usage, not source or finding text. Matching is one-to-one; precision/recall are proxies and require human adjudication. Evaluation invokes a live model unless its runner is injected by tests. No private benchmark corpus or quality claim is included in this update.

## Operations and upgrade

CI builds/tests under Node 24, exercises real Redis, Unix sockets and native isolation, audits dependencies, builds both images and probes Codex. Dependabot proposes dependency updates. Heartbeats make readiness require both workers. Metrics add queue delay, analysis duration, token usage, rejected anchors, Redis memory and free review-disk space. Worktree cleanup runs periodically; low disk pauses analysis. Redis uses `noeviction`, bounded queue retention and a 384 MB memory ceiling. Monitor memory well before the limit; successful artifacts are removed, but per-PR state and mirrors still need operator retention planning.

This release changes queue/state semantics. **Do not perform a rolling upgrade across old and new workers.** Stop the webhook server, let both queues drain, stop workers, back up Redis and protected credentials, and record source revision, CLI pin, npm lockfile digest and image digests/IDs. Build and validate both new images, then start the stack together. Reconciliation discovers missed eligible scopes. Do not clear live Redis to upgrade.

After building, `npm run release:manifest -- /protected/release.json APP_IMAGE ANALYSIS_IMAGE` records source revision/dirty status, lockfile/policy hashes, CLI pin and both Docker image IDs/digests. Run it with the same public policy environment as the services; it does not capture credentials. Promote a committed, clean revision after validation.

Use `APP_IMAGE` and `ANALYSIS_IMAGE` in the Compose environment to select immutable promoted image digests, then start with `--no-build`. Use immutable image digests for promoted releases and retain the previous image pair, environment and Redis snapshot. A rollback stops all three processes and restores the matching old state snapshot before starting the old image pair; replayed reviews must be checked against GitHub receipts. Restore rehearsal belongs in a separate disposable Redis volume with workers disabled until ready. Never restore a backup over running workers. Follow `DEPLOYMENT.md` for the protected backup procedure.

Owner acceptance remains: live model/account canary, App identity and restricted token permissions, retarget/push while reviewing, ambiguous publication retry, comment authorization/Check Runs if enabled, disk/memory alerts, and backup/restore rehearsal. This update does not deploy the existing VPS services.
