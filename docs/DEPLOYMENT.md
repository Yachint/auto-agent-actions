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

### Nested Codex sandbox

Repository content is untrusted, so Codex keeps its Linux Bubblewrap sandbox enabled inside the analysis container. The analysis image installs the system `bubblewrap` package and enables its setuid mode, as OpenAI's secure non-root devcontainer does. Only that service receives `SYS_ADMIN`, `SYS_CHROOT`, `SETUID`, and `SETGID`, plus unconfined seccomp/AppArmor profiles, so Bubblewrap can create the nested namespace on Ubuntu hosts that restrict unprivileged user namespaces. The server, publisher, and Redis retain dropped capabilities, `no-new-privileges`, and their normal profiles.

This is an intentional transfer of the repository-execution boundary from Docker's default seccomp/AppArmor profile to Codex's inner read-only sandbox. The analysis root filesystem remains read-only and its application process remains UID/GID-remapped and non-root. Unlike the other services, analysis cannot use `no-new-privileges`, because that would prevent the trusted setuid Bubblewrap executable from creating the inner namespace; Codex and Node do not run as root. GitHub write credentials remain absent, and the worker runs a real `codex sandbox ... /bin/true` smoke test before connecting to Redis or consuming jobs. If the smoke test fails, the container exits and logs a bounded, control-character-stripped diagnostic; no review can be published. Do not replace the inner sandbox with `danger-full-access`; OpenAI warns that untrusted project content could then access credentials available inside the container. See [OpenAI's container sandbox guidance](https://learn.chatgpt.com/docs/agent-approvals-security#run-codex-in-dev-containers) and its [secure devcontainer image](https://github.com/openai/codex/blob/main/.devcontainer/Dockerfile.secure).

## Host preparation

Verify Docker Engine, the Compose plugin, and the host-network Traefik stack are healthy. Point `autoreview.yachint.in` to the VPS. Clone this repository under `/opt/auto-agent-actions` or another root-owned application directory.

Create a deployment environment file:

```bash
cp .env.vps.example .env.vps
chmod 600 .env.vps
```

Set `CODEX_CLI_VERSION` to the exact tested CLI version reported by `codex --version`. Keep the Redis image version pinned; after validation, prefer an immutable image digest.

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
  codex sandbox -c 'sandbox_mode="read-only"' -- /bin/true
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
