# Auto Agent Actions — Project Memory

This file is the durable, chronological handoff for future development sessions. Record material changes and decisions without secrets or private repository content. The detailed target design remains in `docs/PLAN.md`.

## 2026-07-15 — Project direction

- The service will be a self-hosted GitHub pull request reviewer powered by Codex CLI.
- TypeScript on Node.js was selected, with Fastify, Pino, Vitest, and native ESM.
- Delivery will follow `docs/PLAN.md`, starting with a local end-to-end proof of concept before live GitHub publishing, queues, or VPS hardening.
- Security priorities are credential isolation, exact-diff validation, stale-SHA rejection, and idempotency.

## 2026-07-15 — Initial scaffold

- Initialized the npm project with strict TypeScript and NodeNext module resolution.
- Added Fastify health endpoints at `/health/live` and `/health/ready`.
- Added build, development, start, and Vitest commands plus `.env.example` and `.gitignore`.
- Static runtime assets are copied into `dist` by `scripts/copy-assets.mjs` after compilation.

## 2026-07-16 — Structured review output

- Added a strict Draft 7 JSON Schema at `src/codex/review-schema.json` with no additional properties.
- Priority uses integer P0–P3; confidence is constrained to 0–1.
- Added Ajv validation plus semantic checks for normalized repository-relative paths and ordered line ranges.
- Codex output is treated as untrusted. Exact changed-line anchoring remains a separate Git diff validation responsibility.

## 2026-07-16 — Trusted Codex execution

- Added an immutable prompt generator scoped to repository, PR number, base SHA, and head SHA.
- Added trusted `review-instructions.md` so review runs do not rely on repository-controlled `AGENTS.md` instructions.
- Codex prompts are passed over stdin rather than process arguments.
- The runner uses a read-only sandbox, ephemeral sessions, ignored user config/rules, strict config parsing, disabled web search/apps, a no-approval policy, timeouts, and output-size limits.
- Only a small environment allowlist reaches Codex; GitHub credentials and unrelated variables are excluded.
- Schema, instructions, and result files are required to live outside the review worktree.
- Current Codex CLI uses `-c approval_policy="never"`; the older plan example using `--ask-for-approval never` is obsolete for the installed CLI.

## 2026-07-16 — Durable agent context

- Added root `AGENTS.md` as the project-wide architecture and working guide.
- Added this `MEMORY.md` as the chronological decision and progress log.
- Future material implementation and architecture decisions must update this file in the same change.

## 2026-07-16 — Repository, worktree, and exact-diff foundation

- Added a Git execution boundary that uses argument arrays rather than a shell, disables Git hooks, ignores ambient system/global Git configuration, disables terminal prompts, limits output, and drops unrelated environment credentials.
- Bare mirrors are initialized under a configurable data directory. Fetch URLs are never saved as Git remotes.
- The current prototype accepts absolute local repository paths or credential-free HTTPS URLs only. Embedded URL credentials, query strings, SSH URLs, and interactive credential lookup are rejected; short-lived GitHub App authentication will be added with the GitHub integration milestone.
- Pull request base/head refs are fetched into fixed internal namespaces and compared with full expected SHAs. Mismatches fail as stale review refs.
- Reviews use detached disposable worktrees at the exact head SHA. Worktree creation and checkout are verified, and `withWorktree` guarantees cleanup.
- Exact diffs are inspected from the specified base SHA to head SHA. NUL-delimited file records support additions, modifications, deletions, and renames; copied paths are conservatively treated as additions.
- Right-side changed-line ranges are extracted per file with zero context. Modified renames diff both old and new paths to avoid treating unchanged renamed lines as additions.
- Findings outside a changed right-side range, including deleted files, are omitted by `filterFindingsToExactDiff`.
- Configurable changed-file and per-file patch-output limits fail closed on oversized reviews.

## 2026-07-16 — Milestone 1 local orchestration

- Added strict parsing for saved GitHub `pull_request` webhook fixtures. Only `opened`, `reopened`, `synchronize`, and `ready_for_review` actions on open, non-draft pull requests are eligible.
- Added `runLocalReview`, which connects fixture parsing, exact ref fetching, disposable worktrees, exact diff inspection, trusted prompt generation, Codex execution, schema validation, and changed-line filtering.
- The workflow inspects the diff before Codex runs, then removes unsafe findings after the run. It always deletes the temporary Codex output file and worktree, including on failures.
- Added `npm run review:fixture -- <fixture.json>` as the local proof-of-concept command. It supports a local/HTTPS remote override, configurable data directory, required model, timeout, and Codex binary.
- The local command prints a proposed review and rejected anchor metadata as JSON. It does not call the GitHub API or publish anything.
- Added a sanitized example webhook fixture and real-Git integration tests with an injected fake Codex process boundary.

## 2026-07-16 — First-release product and authentication decisions

- Target repositories may be public or private but are limited to explicitly allowlisted personal repositories.
- Forked pull requests are out of scope for the first release. Payload validation now rejects a head repository that differs from the base repository before Git or Codex runs. Fork support remains future scope and requires a stronger credential boundary and threat-model review.
- Reviews use `gpt-5.6-sol` with `high` reasoning effort. Fast service is not enabled; ignoring user config keeps per-user fast settings from leaking into automated runs.
- The first release publishes advisory GitHub `COMMENT` reviews only. It will not approve, request changes, or enforce a required status check.
- The selected Codex authentication path is the ChatGPT subscription login already cached on the dedicated VPS. `codex exec` reuses saved CLI authentication and refreshes active ChatGPT sessions during use.
- ChatGPT-managed non-interactive automation is an advanced authentication path. OpenAI explicitly advises against it for public/open-source repositories. Before enabling a public repository, deployment must use a dedicated OS user/container, selected-repository allowlisting, same-repository PR enforcement, no repository program execution, read-only review worktrees, and protected credential storage. Revisit API-key proxy or access-token isolation before fork support or broader contributors.
- Private GitHub App creation and installation will be performed with the owner after the remaining local implementation is ready. The app will be installed only on selected repositories with minimal permissions.

## 2026-07-16 — GitHub webhook ingestion boundary

- Added an opt-in `POST /webhooks/github` handler that preserves the raw JSON body and verifies `X-Hub-Signature-256` with HMAC-SHA256 and a timing-safe comparison before parsing payload data.
- The handler accepts only pull-request events and supported review actions, enforces the selected-repository allowlist and same-repository/no-fork policy, and queues only immutable minimal review metadata.
- Delivery claiming and review enqueueing are injected boundaries. Duplicate delivery IDs return success without a second job; a failed enqueue releases its claim so GitHub retries are not silently lost.
- The current in-memory delivery-claim implementation is test/prototype-only. Durable deduplication and queueing will be implemented atomically with Redis in Milestone 3.

## 2026-07-16 — GitHub App client and advisory publisher

- Added GitHub App JWT signing with RS256, short-lived claims, clock-drift allowance, and repository-scoped installation tokens restricted to contents read and pull-requests write permissions.
- Installation tokens are treated as opaque variable-length secrets and cached only in memory until five minutes before expiry. API failures do not include credentials or response bodies in errors.
- Added a versioned GitHub REST client for current pull-request state and review creation. Review writes always use the `COMMENT` event, exact `commit_id`, and right-side line anchors rather than deprecated diff positions.
- The trusted publisher revalidates structured output and exact-diff anchors, applies a confidence threshold and inline-comment cap, then rechecks open/draft/fork/head-SHA state immediately before publishing. Stale results are discarded and zero safe findings produce no GitHub request by default.
- Published summaries contain a machine-readable reviewed-head marker. Durable identical-review suppression will be added with persistent review state.

## 2026-07-16 — Private Git fetch credential boundary

- Split GitHub installation tokens by purpose: repository workers receive repository-scoped `contents: read` tokens, while trusted publishers receive separate `pull_requests: write` tokens.
- Private GitHub HTTPS fetches use Git's askpass protocol with the fixed username `x-access-token`. Tokens are supplied only in the Git subprocess environment, never in URLs, arguments, Git configuration, errors, or persistent credential files.
- The askpass executable contains no credential data, lives in a mode-0700 temporary directory beneath the trusted data directory, and is removed after both successful and failed fetches.
- Authenticated fetch URLs must exactly match `https://github.com/<allowlisted-owner>/<allowlisted-repository>.git`. Local and other-host URLs cannot receive GitHub credentials.

## 2026-07-16 — Durable queue and stale-run state

- Added BullMQ 5.80.5 as the Redis-backed queue. Per-PR jobs use a short replaceable debounce while waiting and `keepLastIfActive` while running, which retains at most one active job and one latest follow-up job.
- Delivery IDs become opaque unique job IDs, and per-PR deduplication IDs are SHA-256 hashes. Jobs have bounded payload size, three exponential-backoff attempts, bounded stack traces, and retention limits.
- Added atomic Redis state transitions for `latest_requested_head_sha`, `currently_running_head_sha`, `last_reviewed_head_sha`, status, and timestamps. Redis keys hash repository/PR identities instead of embedding them.
- Workers acquire a per-PR/head lease before processing and can recheck it before publishing. Newer requests supersede active output; obsolete queued jobs exit without running the review workflow.
- Durable `last_reviewed_head_sha` state also rejects retained, redelivered, or manually retried jobs for an already-reviewed head, preventing identical review publication for the same commit.
- Queue insertion failures transition the requested state to retryable failure before propagating the error. Webhook delivery claims are persisted with a TTL and released when enqueueing fails.
- The first release will use Redis for BullMQ and operational review state, avoiding a separate PostgreSQL or SQLite dependency. VPS deployment must enable Redis persistence and backups. PostgreSQL is deferred until durable relational history or analytics are needed.

## 2026-07-16 — Live composition and split worker privileges

- Refactored local review orchestration into a reusable exact-head analysis core. It fetches the current base/head, creates a disposable worktree, runs trusted Codex instructions, validates output, and filters findings against the exact diff.
- Wired the webhook server to BullMQ, Redis delivery claims, atomic Redis review state, strict environment configuration, and Redis-backed readiness checks.
- Split execution into separate analysis and publication queues and processes. Persisted queue payloads are treated as untrusted and revalidated at both worker boundaries; publication completes review state only after a handled post or intentional no-post result.
- The analysis worker reads live pull-request state before reviewing. Both workers discard stale work and enqueue the newest API head, and queue insertion rollback preserves the previously active head where necessary.
- The GitHub App private key is loaded only by the publisher. A publisher-side authenticated Unix-socket broker issues only allowlisted repository-read tokens; the analysis client rejects write-token requests. The socket directory and socket use restrictive permissions, and the shared secret supports file-based loading.
- Analysis tokens use `contents: read` and `pull_requests: read`; publication tokens use only `pull_requests: write`. The Codex subprocess environment remains separately allowlisted and receives neither token.
- Added strict entry-point configuration, dedicated server/analysis/publisher scripts, integration coverage for the privileged handoff and stale-result behavior, and an opt-in real Unix-socket round-trip test.

## 2026-07-16 — Recovery, observability, and deployment packaging

- Added scheduled reconciliation in the privileged publisher. It resolves the GitHub App installation for every allowlisted repository, paginates open pull requests, skips drafts and forks, and submits deterministic current-head requests through existing queue/state idempotency.
- Added startup cleanup for allowlisted abandoned worktrees older than a configurable threshold. Cleanup validates data-directory containment, repository/PR/name structure, directory type, and age before Git removal or safe orphan removal.
- Added Redis-backed operational counters and internal Prometheus text output for webhook, analysis, publication, reconciliation, duration, and queue-state metrics. Caddy exposes only the webhook route, not health, readiness, or metrics.
- Added a multi-stage container build and a five-service Compose topology for Caddy, webhook server, Redis, publisher, and analysis. Services use separate secrets, internal networks, read-only roots, dropped capabilities, no-new-privileges, non-root users, resource limits, Redis AOF/snapshots, and isolated persistent volumes.
- Only the analysis container mounts the dedicated read-write `CODEX_HOME`; only the publisher mounts the GitHub App private key. The Compose network split limits service reachability, but hostname-level outbound restrictions still require a host firewall or forward proxy.
- Added `docs/DEPLOYMENT.md` and `.env.vps.example` with credential handling, device-code login, preflight, launch, rotation, persistence, and backup guidance. Docker is unavailable in the development environment, so Compose runtime validation is explicitly deferred to the VPS.
- Added `docs/ACCEPTANCE.md` mapping every first-release criterion to local evidence and listing the remaining live Docker, GitHub, stale-head, recovery, credential-isolation, and backup checks. The final local build passed with 105 standard tests; the opt-in real broker socket test also passed, Compose security boundaries were machine-checked, and the production npm audit reported zero vulnerabilities.
- Added a non-secret VPS preflight command that validates deployment values, protected file metadata, Codex credential ownership, required host tools, and resolved Compose configuration without reading or printing secret contents.
- Added a current GitHub App setup guide covering private visibility, minimum permissions, the sole pull-request event, webhook security, selected-repository installation, key handling, and delivery verification.
- The local Codex CLI 0.144.5 exposes every locked-down runner flag. The analysis container build now verifies its pinned CLI version and required flags before producing an image.

## Unresolved decisions

- The checked-in Compose stack still requires syntax/build/runtime validation on a Docker host, Redis backup/restore rehearsal, and host-level egress controls before public-repository launch.
- Private GitHub App creation, installation, webhook delivery testing, and the first real advisory review require the owner.
- Whether ChatGPT subscription authentication provides an acceptable security boundary for public repositories after the VPS isolation design is implemented and tested.
