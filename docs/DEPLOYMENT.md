# VPS deployment guide

This guide prepares the isolated first-release deployment. Use `docs/GITHUB_APP_SETUP.md` for the exact owner-side App registration and installation settings.

## Security layout

The Compose stack runs four services behind the VPS's existing host-network Traefik:

- The webhook server receives only the webhook secret. It joins Redis's internal backend and a named internal edge network used by Traefik.
- Redis is reachable only on the internal backend network and persists queue/state data with AOF and snapshots.
- The analysis worker owns the Codex credential directory and review worktrees. It does not receive the GitHub App private key.
- The publisher owns the GitHub App private key and brokers allowlisted read tokens to the analysis worker over a shared Unix socket.

No service publishes a host port. The existing Traefik Docker provider discovers only the labeled webhook server, selects `auto-agent-actions-edge`, and routes the exact `/webhooks/github` path through the existing `websecure` entrypoint and `letsencrypt` certificate resolver. Health, readiness, and metrics routes are not exposed. Docker documents that the host can communicate directly with container IPs on an internal network while containers on that network remain externally isolated; this preserves the webhook server's no-egress boundary. See [Docker internal network mode](https://docs.docker.com/reference/cli/docker/network/create/#network-internal-mode---internal).

Both workers need outbound HTTPS: analysis needs GitHub fetch/API access and OpenAI inference; publisher needs GitHub API access. Docker Compose cannot enforce a hostname-level egress allowlist. Before reviewing public repositories, add a host firewall or authenticated forward proxy that restricts these containers to the required GitHub and OpenAI endpoints, then repeat the isolation audit. Forks remain rejected regardless.

### Codex sandbox

Repository content is untrusted, so Codex shell commands remain OS-sandboxed inside the analysis container. This VPS rejects Bubblewrap's nested network namespace with `RTM_NEWADDR: Operation not permitted` even when the upstream container capability profile is present. Both startup preflight and reviews therefore explicitly select Codex's documented legacy Landlock backend. Landlock enforces the read-only filesystem policy without setuid executables or nested namespace capabilities, while Codex's Linux sandbox retains its syscall-level network restrictions.

Every application service now keeps Docker's default seccomp/AppArmor profiles, `cap_drop: ALL`, `no-new-privileges`, a read-only root filesystem, and a UID/GID-remapped non-root process. GitHub write credentials remain absent from analysis. Before connecting to Redis or consuming jobs, the worker runs `codex sandbox` under Landlock and attempts to write into the container's otherwise-writable `/tmp`; startup succeeds only when that write is denied. A failure exits the container with a bounded, control-character-stripped diagnostic, and no review can be published. Do not replace this with `danger-full-access`; OpenAI warns that untrusted project content could then access credentials available inside the container. See [OpenAI's container sandbox guidance](https://learn.chatgpt.com/docs/agent-approvals-security#run-codex-in-dev-containers) and the [Codex Linux sandbox backend documentation](https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md).

## Host preparation

Verify Docker Engine, the Compose plugin, and the host-network Traefik stack are healthy. Point `autoreview.yachint.in` to the VPS. Clone this repository under `/opt/auto-agent-actions` or another root-owned application directory.

Create a deployment environment file:

```bash
cp .env.vps.example .env.vps
chmod 600 .env.vps
```

Set `CODEX_CLI_VERSION=0.155.1`, the release currently validated by this application. Upgrade it only after the image-build compatibility check, read-only sandbox smoke test, structured-output review path, and full application suite pass. Keep the Redis image version pinned; after validation, prefer immutable image digests.

Set `APP_UID` and `APP_GID` in `.env.vps` to the numeric IDs reported by `id -u` and `id -g` for the deployment administrator. The image builds its unprivileged runtime account with those IDs so file-backed Compose secrets and the Codex credential bind mount remain readable without granting another host account access.

Prepare secret and credential directories. Files containing secrets must use the configured owner/group and mode 0600; the Codex directory must use the same owner/group and mode 0700:

```bash
sudo install -d -m 0700 -o "$(id -u)" -g "$(id -g)" /opt/auto-agent-actions/secrets
sudo install -d -m 0700 -o "$(id -u)" -g "$(id -g)" /opt/auto-agent-actions/codex-home
openssl rand -hex 32 | sudo tee /opt/auto-agent-actions/secrets/read-token-broker-secret >/dev/null
sudo chown "$(id -u):$(id -g)" /opt/auto-agent-actions/secrets/read-token-broker-secret
sudo chmod 0600 /opt/auto-agent-actions/secrets/read-token-broker-secret
```

The official Codex documentation says cached credentials live under `CODEX_HOME` (by default `~/.codex`) in `auth.json` or an OS credential store, and file-based `auth.json` must be treated like a password. This deployment mounts the dedicated Codex directory read-write into only the analysis container so ChatGPT tokens can refresh. See [OpenAI authentication and credential storage](https://learn.chatgpt.com/docs/auth#credential-storage).

Authenticate the exact containerized CLI with device-code login:

```bash
docker compose --env-file .env.vps build analysis
docker compose --env-file .env.vps run --rm --no-deps analysis codex login --device-auth
docker compose --env-file .env.vps run --rm --no-deps analysis codex login status
```

Do not copy `auth.json` into the image or repository. Subscription-backed automation remains limited to allowlisted personal, same-repository PRs. OpenAI recommends API-key authentication for programmatic CI/CD workflows and warns against exposing Codex execution in untrusted or public environments; the selected subscription path therefore remains gated by the public-repository isolation review. See [OpenAI authentication](https://learn.chatgpt.com/docs/auth).

## Preflight before GitHub credentials

From the repository root, run:

```bash
npm ci
npm run build
npm test
npm run preflight:vps -- .env.vps
docker compose --env-file .env.vps config
docker compose --env-file .env.vps build
docker compose --env-file .env.vps run --rm --no-deps analysis \
  codex sandbox -c 'sandbox_mode="read-only"' \
  -c 'features.use_legacy_landlock=true' -- \
  /bin/sh -c "if /bin/sh -c ': > /tmp/auto-agent-actions-sandbox-write-probe'; then rm -f /tmp/auto-agent-actions-sandbox-write-probe; exit 1; else exit 0; fi"
```

The protected preflight validates non-secret values, required file types/sizes/permissions, the Codex directory owner and `auth.json` metadata, host commands, and the resolved Compose configuration. It does not read or print secret contents. The analysis image build verifies that the pinned Codex CLI version exposes every isolation/output flag used by the runner, while the explicit smoke command verifies the VPS kernel/container namespace path. Placeholder files may be used only for early image-build work; the protected preflight and services must not be run with placeholders.

After the GitHub App is created, put its private key and a new webhook secret at the host paths named in `.env.vps`, then run:

```bash
docker compose --env-file .env.vps up -d
docker compose --env-file .env.vps ps
docker compose --env-file .env.vps logs --tail=100 server analysis publisher
```

Confirm the server is healthy from inside its container, no project service publishes a host port, and Traefik reports a healthy `auto-agent-actions` router/service. Do not paste logs containing private repository data into public issues.

The analysis logs must contain `Codex read-only sandbox preflight passed` before `abandoned worktree cleanup completed`. A restart loop with `CodexExecutionError` means the inner sandbox is unavailable; do not trigger reviews or bypass the sandbox.

## Persistence and operations

- Back up the `redis-data` volume after a successful `BGSAVE`; retain and test restore copies off the VPS.
- Back up neither disposable `review-data` worktrees nor the broker socket volume.
- Back up the Codex credential directory only into encrypted storage; prefer re-authentication over broad credential replication.
- Rotate the webhook and broker secrets after suspected exposure. Rotate the GitHub App private key through GitHub and restart the publisher.
- Apply OS and container image updates regularly, rerun the full test/build preflight, and inspect dependency audit results before rollout.
- Monitor restart counts, Redis persistence errors, queue depth, failed jobs, stale-result discards, reconciliation failures, and disk usage.

### Usage limits and resumable reviews

Quota exhaustion defers analysis behind a persistent queue-wide cooldown without consuming an analysis attempt. Other failures have a bounded attempt allowance; blocked inspection is terminal immediately. Reconciliation preserves an exhausted scope instead of deleting the failed job and resetting its attempts. A changed head/base/policy or an explicitly requested rerun creates a new scope. Stopping analysis prevents further model calls but makes readiness unhealthy.

`CODEX_AGENT_THREADS=1` disables delegation. Adaptive effort can lower the configured effort and thread count but cannot raise them. Monitor the account's five-hour meter as well as token counters; token counts do not directly predict subscription usage.

Analysis requires per-job isolation to enforce parent-owned budgets. With staged inspection enabled, each inspection, integration, and verification unit has an independent unit budget, and every upstream response also charges a separate aggregate PR budget. Without staged inspection, the original ceilings still cover the complete attempt:

| Setting | Default | Scope |
| --- | --- | --- |
| `REVIEW_MAX_MODEL_REQUESTS` | 24 | Each stage unit; complete attempt when staging is disabled |
| `REVIEW_MAX_GROUP_REQUESTS` | 8 | Each model invocation, including final verification |
| `REVIEW_MAX_REQUEST_BYTES` | 65536 | Each encoded request, checked before upstream dispatch |
| `REVIEW_MAX_INPUT_TOKENS` | 200000 | Observed gross input per unit, including cached input; complete attempt without staging |
| `REVIEW_MAX_OUTPUT_TOKENS` | 10000 | Observed output per unit; complete attempt without staging |
| `REVIEW_MAX_PR_REQUESTS` | 400 | All stage units in the queued review attempt |
| `REVIEW_MAX_PR_INPUT_TOKENS` | 4000000 | Aggregate observed gross input across all stages |
| `REVIEW_MAX_PR_OUTPUT_TOKENS` | 100000 | Aggregate observed output across all stages |

Request count and request size have strict admission ceilings. Upstream calls are serialized so concurrent agent calls cannot race the token check. Token ceilings use reported response usage: one already-dispatched response can exceed a token ceiling, at which point the child is aborted and no further requests are admitted. Missing, malformed, or oversized usage events fail closed; credential failures and quota cooldown keep their existing precedence. These limits do not represent a percentage of subscription allowance, so retain account-meter monitoring for live acceptance.

Budget failures discard the job on its first failed attempt and persist the exhausted scope; reconciliation cannot reset them. Other failures retain the existing bounded retry policy. Quota deferral or an explicit new attempt creates a fresh in-memory budget, while completed checkpoints can still be reused. Changing a budget changes scheduling policy identity but does not invalidate otherwise identical completed checkpoints. Coordinate worker versions before promotion.

Safe per-request logs include attempt ID, phase/group numbers, request and tool-output byte counts, input-item count, elapsed time, status, usage-observed flag, and input/cached-input/output token counts. Invocation summaries include aggregate counts and existing tool success/failure diagnostics. Commands, paths, model text, and credentials are never included. This instrumentation is forward-looking; it cannot recover the previous trial's missing per-request token breakdown.

`REVIEW_BATCH_FILES` is blank by default. Values 1 through 32 enable staged content-sized inspection and specify the maximum paths per unit, not a fixed group size. Units contain at most 24 KiB of escaped patch JSON with three lines of surrounding context. Static relative-import references visible in patches, matching implementation/test names and directory proximity provide deterministic affinity; this is a heuristic, not a complete dependency graph. Oversized files/hunks/lines are split with exact original patch offsets and source coordinates. The planner reconstructs and hashes the full patch for each path before any model call; empty, binary-metadata and deletion-only patches are included. Limits are 5 MiB per-file Git output, 32 MiB total patch data and 256 units. Exceeding a planning limit fails closed.

The complete review remains one queue attempt: sequential inspections, a cross-component pass for multi-unit plans, then independent verification of every candidate in bounded batches, even when `REVIEW_VERIFY_FINDINGS=false`. Integration notes are untrusted leads and can be shortened; findings require frozen code evidence. Integration failure blocks completion even if all inspection units are cached. The same PR budget includes inspection, integration and verification. A unit failure ends the attempt; it never silently resets its allowance or automatically asks for another review. Exact-diff and current-head publication checks are unchanged.

Completed units are checkpointed under `REVIEW_DATA_DIR/checkpoints`. Keys bind trusted scope/policy and exact slice data; only validated outputs and path metadata are stored, never raw patch slices. The new content-unit policy intentionally does not reuse old four-file checkpoints as evidence of complete slice coverage. Budget-only changes preserve otherwise compatible checkpoints. Promotion must coordinate all application versions, keep analysis stopped until the new explicit aggregate ceilings are selected, and reserve account allowance for one monitored end-to-end acceptance run; do not use an operator resume loop as routine scheduling.

Checkpoints contain validated review results and path metadata, which can include private code excerpts in finding bodies. They contain no raw prompts, patches, or credentials. Files use mode 0600, the directory uses mode 0700, writes use atomic replacement, and reads reject symlinks, oversized files, malformed output, and scope mismatches. Each file is capped at 1 MiB; a bounded 256-unit plan can retain up to 256 MiB per scope, excluding filesystem overhead. Actual schema-validated outputs are normally much smaller. No automatic retention cleanup is configured, so account for accumulated scopes in disk monitoring. Checkpoints are disposable and need no backup; do not delete them during an active review. Coordinate worker versions before changing the flag because it changes the scheduling policy. Enabling this persistent cache and its runtime setting requires the owner's specific machine-change authorization.

October 6 incident acceptance: the retry/cooldown fixes through `6b997ed` were deployed using derived images with existing dependencies. The current 123-path Agenda PR still returned a blocked inspection despite successful Git/tool calls; it did not produce a completed review. Analysis was stopped at the agreed usage threshold. The owner then authorized the 16-file resumable option and a trial capped at 65% five-hour usage. All application services were promoted to `bb6c12c`; the first inspection group was still running when the ceiling was reached after roughly 70 seconds, so analysis was stopped. No completed-group progress was logged. The job remains delayed after one attempt; the option is configured but analysis is stopped. Live checkpoint resume and full review completion remain unverified.

Subsequent budget/diagnostics verification ran exclusively on the VPS with preinstalled Node 24.21.0, TypeScript 7.0.2 and Vitest 4.1.11. It used read-only dependencies, disabled Vitest caches, disposable network-isolated Redis, Unix sockets, and the preinstalled native sandbox/Codex CLI with simulated inference. Build/static assets and all 254 tests passed, with no package installation or production model calls. The real CLI tool-loop test was stopped after exactly two simulated requests. Budget-enabled runtime promotion and a smaller live pilot remain pending; production analysis stays stopped.


## September 2026 upgrade

Read [PIPELINE_V2.md](PIPELINE_V2.md) before upgrading: the queue/state protocol requires a drained, coordinated worker restart and matching Redis backup for rollback. Pin Codex CLI 0.155.1 until a newer version passes both sandbox probes. The native job boundary needs Landlock ABI 4 or later; account-token refresh and live model routing require owner verification. Optional Checks and comment commands require App permission/event changes before enabling their environment flags.
