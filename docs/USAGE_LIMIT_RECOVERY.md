# Usage-limit incident recovery

The fix for the incident reported in `Yachint/agenda#17` targets the deployed `c9c2bdc` source. Build and standard tests pass; real Redis/BullMQ restart and Linux isolation tests are opt-in and were not run on the development Mac. The Agenda checkout is untouched. On October 6, 2026, the owner authorized committing/pushing the fix, pulling it on the VPS, applying the resource settings below, restarting services and verifying pending-job processing.

The fix adds a durable model cooldown, pending-job deferral without failure comments/retry consumption, safe cause metadata, upstream usage accounting before later failures, and explicit agent/effort ceilings. Existing model and high-effort defaults are retained. Proposed incident settings are:

```dotenv
CODEX_MODEL=gpt-6.1-sol
CODEX_REASONING_EFFORT=medium
CODEX_AGENT_THREADS=1
REVIEW_ADAPTIVE_EFFORT=true
```

One large review may still exceed the account's allowance. These settings reduce work; completion must be verified with a real review after owner authorization. Usage metrics include only events received with valid usage fields, not a complete billing ledger.

## Authorized deployment

1. Verify the server remains at `c9c2bdc` without unrelated edits. Preserve protected copies of its Compose configuration, image references and Redis persistence files. Keep Redis running; pause server/publisher together with the already-stopped analysis worker during promotion.
2. Commit only the incident changes, push them and pull the exact commit on the server. Preserve unrelated local `AGENTS.md` and historical `MEMORY.md` edits. Transfer the verified compiled `dist/src` assets separately for image promotion.
3. Create two new image tags derived from the exact existing app and analysis image IDs. Replace only `/app/dist/src`; retain the installed dependencies, native sandbox, Node runtime and Codex CLI 0.155.1. This avoids package installation/upgrades and full Docker builds. Record original and derived image identities for rollback.
4. Update only the proposed resource settings and the app/analysis image references in the protected `.env.vps`. Resolve Compose quietly and check that all three application services receive the same policy settings. Recreate server, publisher and analysis without a build or image pull. Preserve all volumes, credentials and queue contents.
5. Check sandbox preflight, service readiness, pending review recovery, cooldown behavior and publication. Starting the analysis worker allows queued/reconciled reviews to consume the service account's usage and publish through its existing GitHub App authorization.

The compiled assets total approximately 404 KiB. Derived images reuse existing layers; source/artifacts and protected backups should use tens of MiB, depending on Redis data size. No new long-running services are proposed. The three existing application services restart; a short webhook interruption is expected. At inspection the server had 4.6 GiB free and two delayed review jobs.

If promotion or live validation fails, restore the original image references and configuration, recreate server/publisher and keep analysis stopped while diagnosing. Do not erase Redis state, credentials or review data, or remove old images as part of this incident.

## Follow-up after the owner paused production

The owner stopped the containers when usage kept draining after the initial quota/effort fix. Source inspection found that reconciliation removed terminal failed analysis jobs and recreated them with fresh attempts. The follow-up persists terminal analysis exhaustion in Redis and gates scheduling and execution for that scope. Older retained failed jobs are preserved and acquire the same gate. Blocked inspection terminates on its first attempt; other analysis failures have at most two attempts. Missing-job insertion repair remains available. A new head/base/policy or an explicit operator re-review permits a new scope. Quota deferral continues to use the durable cooldown.

The build and 203 standard tests pass, including repeated reconciliation, job-retention loss, scheduling races and stale-owner fencing. Eight optional platform/infrastructure tests were skipped locally. Production remains stopped while the final live blocker is diagnosed; renewed Tailscale SSH authentication is currently required. No live model call was made after the owner paused production.

## Restored access and bounded live acceptance

After SSH access was restored, the owner authorized promotion/restart and continued monitoring. Redis/server/publisher run the exhaustion fix; regular analysis is held while acceptance checks run. Live Redis verified the gate across repeated reconciliation, store recreation and queue-retention loss. A real-model tool-access canary on the exact frozen Git scope passed in two requests (7,001 input, 296 output tokens), without a GitHub review.

Proxy limits now abort promptly with fixed size/count/expiry reasons instead of allowing the CLI to keep retrying a rejected capability. Failed-review diagnostics retain only request/output counters and numeric size metadata, never tool commands, source or credentials. Review guidance uses advertised native tools directly, bounded responses and path groups. The build and 207 standard tests pass; eight optional tests are skipped locally. The service account matches the desktop usage meter. During full-review acceptance, analysis will be paused if five-hour usage reaches 35%, preserving the remaining allowance.
