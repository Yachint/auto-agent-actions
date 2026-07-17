# Auto Agent Actions

Self-hosted pull request reviews powered by Codex CLI. Milestones 1–3 are implemented: signed GitHub webhooks enter a durable Redis queue, an isolated analysis worker reviews the exact pull-request head, and a separately privileged publisher posts validated advisory comments. Milestone 4 deployment isolation, reconciliation, cleanup, health checks, and internal metrics are implemented locally; live container validation and GitHub App setup remain.

## Requirements

- Node.js and npm
- Git
- Codex CLI authenticated with ChatGPT subscription login on the trusted VPS

## Setup

```bash
npm install
npm run build
npm test
```

The selected configuration is GPT-5.6 Sol with high reasoning effort and standard (non-fast) service. Authenticate once on the trusted VPS and verify the cached login:

```bash
codex login --device-auth
codex login status
```

`codex exec` reuses this saved login. Treat the Codex credential store as a password: never copy it into the repository, review data directory, logs, containers shared with untrusted workloads, or chat.

Account-auth automation is intentionally limited to allowlisted personal repositories and same-repository pull requests. Forked pull requests are rejected before Git fetch or Codex execution. OpenAI documents ChatGPT-managed automation as an advanced path and advises against using it for public/open-source repositories, so public-repository deployment requires the dedicated worker isolation described in `docs/PLAN.md` and explicit review before launch.

## Run a local fixture review

Save an `opened`, `reopened`, `synchronize`, or `ready_for_review` GitHub `pull_request` webhook payload, then run:

```bash
npm run review:fixture -- /absolute/path/to/pull-request.json
```

For a local repository fixture, override the payload's `repository.clone_url`:

```bash
npm run review:fixture -- ./pull-request.json --remote /absolute/path/to/repository
```

Optional configuration:

- `REVIEW_DATA_DIR` or `--data-dir`: mirror/worktree data directory; defaults to `.review-data`.
- `CODEX_TIMEOUT_MS` or `--timeout-ms`: Codex timeout; defaults to 600000 ms.
- `CODEX_BINARY`: Codex executable; defaults to `codex`.
- `CODEX_MODEL` or `--model`: defaults to `gpt-5.6-sol`.
- `CODEX_REASONING_EFFORT` or `--reasoning-effort`: defaults to `high`.

The command prints JSON to stdout. It never publishes to GitHub. Findings that cannot be anchored to changed right-side lines are listed under `rejected_findings` and omitted from `review.findings`.

## GitHub webhook status

The server entry point exposes `POST /webhooks/github`, verifies the raw body signature, validates the event, applies the repository allowlist and no-fork policy, claims delivery IDs in Redis, and enqueues minimal immutable metadata. `GET /health/live` checks the process and `GET /health/ready` checks Redis.

See [`docs/REVIEW_TRIGGERS.md`](docs/REVIEW_TRIGGERS.md) for the exact events that do and do not trigger review, scheduled recovery behavior, and the current re-review procedure.

The trusted publisher uses repository-scoped GitHub App installation tokens, fetches the current PR state immediately before publishing, and discards closed, draft, forked, or stale-head results. It publishes only `COMMENT` reviews against the exact reviewed commit. By default, a successful review with no publishable inline findings still posts a summary-only COMMENT so the reviewed outcome is visible; set `REVIEW_PUBLISH_SUMMARY_WITHOUT_FINDINGS=false` to restore silent completion.

Codex output explicitly distinguishes a completed review from a blocked inspection. Blocked output fails the analysis job and cannot enter the publication queue. On Linux deployments, the analysis image follows OpenAI's non-root container pattern by enabling setuid Bubblewrap and granting the required namespace settings only to analysis. The worker runs a real read-only sandbox smoke test before consuming jobs, preventing filesystem-sandbox failures from being mislabeled as successful no-finding reviews.

The GitHub App private key exists only in the publisher process. The analysis worker requests a short-lived repository-read token over an authenticated, mode-0600 Unix socket; the broker enforces the repository allowlist and cannot issue a write token through that route. Git receives the read token through a temporary askpass environment, never through a remote URL, command argument, Git configuration, or persistent credential file. Publisher tokens are separately scoped to `pull_requests: write`.

## Queue status

BullMQ uses separate analysis and publication queues. Analysis jobs are coalesced into one logical stream per repository and pull request: a short debounce replaces rapid waiting updates with the newest head, and an active review retains only one latest follow-up. Redis tracks the latest requested, currently running, and last reviewed head SHAs. Both workers revalidate persisted payloads and state; publication requires the matching lease, and stale results enqueue the newest API head instead of posting.

The first release uses Redis for BullMQ, delivery claims, and operational review state. Production deployment must enable Redis persistence and backups.

The publisher periodically reconciles all open pull requests in allowlisted repositories, so a current head missed during downtime is re-enqueued. The analysis worker removes safely-contained abandoned worktrees older than the configured threshold at startup. Redis-backed counters and queue gauges are available at the internal `/metrics` endpoint; the Traefik router exposes only the exact webhook path.

## Service entry points

After building, the three long-running processes are:

```bash
npm start
npm run start:analysis-worker
npm run start:publisher-worker
```

They require the variables documented in `.env.example`. The publisher owns the GitHub App private key and read-token broker socket. The analysis worker owns the Codex credential store and review data directory. Those credentials must not be mounted into the other service.

For the container topology, secret preparation, Codex login boundary, backups, and launch preflight, follow [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). Owner-side registration settings are in [`docs/GITHUB_APP_SETUP.md`](docs/GITHUB_APP_SETUP.md), trigger behavior is in [`docs/REVIEW_TRIGGERS.md`](docs/REVIEW_TRIGGERS.md), and the split between local evidence and live checks is recorded in [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md).

See `docs/PLAN.md` for the full architecture and future milestones, and `MEMORY.md` for the durable decision log.
