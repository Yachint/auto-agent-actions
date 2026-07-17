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
- Added `docs/ACCEPTANCE.md` mapping every first-release criterion to local evidence and listing the remaining live Docker, GitHub, stale-head, recovery, credential-isolation, and backup checks. The current local build passes with 111 standard tests; the opt-in real broker socket test also passed, Compose security boundaries were machine-checked, and the production npm audit reported zero vulnerabilities.
- Added a non-secret VPS preflight command that validates deployment values, protected file metadata, Codex credential ownership, required host tools, and resolved Compose configuration without reading or printing secret contents.
- Added a current GitHub App setup guide covering private visibility, minimum permissions, the sole pull-request event, webhook security, selected-repository installation, key handling, and delivery verification.
- The local Codex CLI 0.144.5 exposes every locked-down runner flag. The analysis container build now verifies its pinned CLI version and required flags before producing an image.

## 2026-07-17 — Existing VPS Traefik integration

- The VPS already runs Traefik 3.6.17 with host networking, Docker discovery, `exposedByDefault: false`, the `websecure` entrypoint, and the `letsencrypt` resolver. Caddy was removed from this project's deployment topology.
- The webhook server now has explicit Traefik labels for an exact `/webhooks/github` route, a 2 MiB request-body limit, and port 3000. It publishes no host port and selects the stable named network `auto-agent-actions-edge`.
- The Traefik edge network remains `internal: true`. Docker's Linux bridge contract permits direct host-to-container communication on internal networks while denying the container an external route, so host-network Traefik can reach the webhook server without granting it egress.
- Read-only VPS inspection confirmed Docker Engine 29.5.3, Compose 5.1.4, Linux arm64, 2 CPUs, 11 GiB RAM, 9.2 GiB free disk, and an interactive-shell Codex 0.144.5 ChatGPT login. The repository had not yet been cloned to the VPS.
- The owner selected `autoreview.yachint.in` as the production webhook hostname.
- DNS for `autoreview.yachint.in` now resolves to the VPS, and the repository has been cloned to `/home/yachint/auto-agent-actions`. Read-only verification found Node 22.13.1 and npm 11.17.0 in the login shell alongside the previously recorded Docker, Compose, and Codex installations.
- The pinned Codex 0.144.5 analysis image built successfully on the arm64 VPS. After correcting the dedicated `codex-home` bind mount to container UID/GID 1000 with mode 0700, device authorization completed and the container reported `Logged in using ChatGPT`.
- Live deployment exposed that hardcoding container UID/GID 1000 conflicts with the VPS deployment user at UID/GID 1002. File-backed Compose secrets preserve host ownership, so changing secret ownership to an unrelated UID would either fail at runtime or weaken host isolation. Runtime UID/GID are now required build/deployment values, images remap their unprivileged `node` account accordingly, and preflight requires every credential file and directory to match.
- The VPS pulled the runtime identity fix, recreated the still-empty disposable broker/review volumes, rebuilt the analysis image as UID/GID 1002, and confirmed the existing containerized ChatGPT login remained valid.
- The owner created the account-restricted private GitHub App `Agent Auto Review` with App ID `4318657`, the production webhook URL, minimum repository permissions, and only the `pull_request` event. Private-key installation and selected-repository installation remain pending.
- The owner chose selected-repository installation rather than all-repository access; `Yachint/agent-pages` is the first and only initial review target.
- The GitHub App was installed for `Yachint/agent-pages`; App ID, allowlist, PEM, webhook/broker secrets, and ChatGPT credentials were configured on the VPS with the expected UID/GID and restrictive modes. The protected VPS preflight passed environment, credential metadata, host-tool, and resolved Compose checks.
- The first full Compose start exposed an interaction between the official Redis entrypoint and `cap_drop: [ALL]`: its root startup path could not call `setpriv` to switch users. Redis is now configured to start directly as its image-provided `redis:redis` account, retaining the non-root and zero-capability boundary.
- After deploying the Redis fix, all four services started with zero restarts; Redis and the webhook server became healthy. Traefik obtained a Let's Encrypt certificate for `autoreview.yachint.in`, routed only the exact webhook path, and kept readiness publicly unavailable. Reconciliation found one eligible open PR in `Yachint/agent-pages`; analysis completed its trusted handoff and publication safely skipped posting. The host still requires persistent `vm.overcommit_memory=1` configuration before Redis persistence is considered production-ready.
- GitHub App registration sends a `ping` webhook, so the signed webhook boundary now accepts `ping` with HTTP 200 without claiming a delivery or queueing review work. All other non-`pull_request` events remain rejected.
- Live GitHub delivery history confirmed that GitHub Apps also receive mandatory `installation` lifecycle webhooks even when they are not selected. Signed `installation` and `installation_repositories` events are now acknowledged with HTTP 200 as no-ops; other unsupported events remain rejected.
- The original GitHub `ping` and `installation.created` deliveries occurred before Traefik finished obtaining the hostname certificate and therefore recorded the Traefik default-certificate mismatch. Subsequent read-only checks from both the VPS and an external client confirmed the active Let's Encrypt certificate has `autoreview.yachint.in` as its CN/SAN and DNS resolves only to the intended VPS IPv4 address; GitHub redelivery remains required because historical delivery status is not rewritten automatically.
- GitHub redelivery of both `installation.created` and `ping` succeeded with HTTP 200. VPS logs confirmed signature-verified lifecycle acknowledgement and ping acceptance, while the webhook server remained healthy with zero restarts.
- Added `docs/REVIEW_TRIGGERS.md` as the user-facing trigger contract. First-release reviews start for eligible `opened`, `reopened`, `synchronize`, and `ready_for_review` PR actions or missed-head reconciliation; comments and review activity do not trigger re-review. Until authenticated comment commands are designed, pushing a new head SHA (including an empty commit) is the explicit re-review mechanism.
- Live testing showed that silently completing a successful zero-finding review leaves the owner unable to distinguish success from inactivity. Summary-only `COMMENT` reviews are now enabled by default: they identify successful completion, distinguish no actionable issues from findings filtered below the publication threshold, include Codex's substantive change summary, and retain the reviewed-head marker. `REVIEW_PUBLISH_SUMMARY_WITHOUT_FINDINGS=false` remains an explicit opt-out.
- The first live summary-only review exposed a nested-sandbox failure: Ubuntu permitted unprivileged user namespaces generally but restricted them through AppArmor, while the analysis container used `docker-default`, seccomp filtering, and no capabilities. Codex's bundled Bubblewrap could not create a namespace, yet returned a schema-valid empty review whose summary disclosed the failure; the publisher incorrectly labeled it as no issues. The analysis image now installs system Bubblewrap, only the analysis container receives the documented namespace capabilities and unconfined seccomp/AppArmor profiles, and worker startup requires a real read-only sandbox smoke test before Redis/job access. Structured output now requires `completed` or `blocked`; blocked output fails analysis and is rejected at the persisted publication boundary.
- The first nested-sandbox rollout still failed because the analysis worker runs non-root, `/usr/bin/bwrap` was mode 0755, and `no-new-privileges` prevented the privilege transition required on this VPS. OpenAI's secure non-root devcontainer explicitly makes Bubblewrap setuid. The analysis image now follows that pattern and omits `no-new-privileges` only for analysis; the application remains non-root, the other services retain the restriction, and startup diagnostics now expose bounded sanitized preflight stderr.
- The corrected setuid Bubblewrap then reached network-namespace setup but failed to assign the loopback address with `RTM_NEWADDR: Operation not permitted`. Analysis now receives `NET_ADMIN` solely for configuring interfaces inside the nested namespace. `NET_RAW` remains excluded; all other services still drop every capability.
- Read-only VPS verification confirmed the `NET_ADMIN` rollout was current and `/usr/bin/bwrap` retained setuid mode, but the kernel still rejected Bubblewrap loopback configuration. The pinned Codex 0.144.5 binary contains its documented `use_legacy_landlock` fallback. Preflight and reviews now force Landlock, the preflight proves an actual `/tmp` write is denied, and the Bubblewrap package, setuid bit, capability additions, unconfined profiles, and analysis `no-new-privileges` exception have all been removed.

## Unresolved decisions

- The checked-in Compose stack still requires syntax/build/runtime validation on a Docker host, Redis backup/restore rehearsal, and host-level egress controls before public-repository launch.
- Private GitHub App creation, installation, webhook delivery testing, and the first real advisory review require the owner.
- Whether ChatGPT subscription authentication provides an acceptable security boundary for public repositories after the VPS isolation design is implemented and tested.
