# VPS deployment guide

This guide prepares the isolated first-release deployment. Use `docs/GITHUB_APP_SETUP.md` for the exact owner-side App registration and installation settings.

## Security layout

The Compose stack runs five services:

- Caddy is the only public service and forwards only `/webhooks/github`.
- The webhook server can reach only Redis and Caddy's internal edge network. It receives only the webhook secret.
- Redis is reachable only on the internal backend network and persists queue/state data with AOF and snapshots.
- The analysis worker owns the Codex credential directory and review worktrees. It does not receive the GitHub App private key.
- The publisher owns the GitHub App private key and brokers allowlisted read tokens to the analysis worker over a shared Unix socket.

Both workers need outbound HTTPS: analysis needs GitHub fetch/API access and OpenAI inference; publisher needs GitHub API access. Docker Compose cannot enforce a hostname-level egress allowlist. Before reviewing public repositories, add a host firewall or authenticated forward proxy that restricts these containers to the required GitHub and OpenAI endpoints, then repeat the isolation audit. Forks remain rejected regardless.

## Host preparation

Install Docker Engine with the Compose plugin, point the webhook hostname to the VPS, and allow inbound TCP 80/443 plus UDP 443 if HTTP/3 is desired. Clone this repository under `/opt/auto-agent-actions` or another root-owned application directory.

Create a deployment environment file:

```bash
cp .env.vps.example .env.vps
chmod 600 .env.vps
```

Set `CODEX_CLI_VERSION` to the exact tested CLI version reported by `codex --version`. Keep the Redis and Caddy image versions pinned; after validation, prefer immutable image digests.

Prepare secret and credential directories. Files containing secrets must be owned by the deployment administrator and mode 0600. The Codex directory must be accessible only to container UID 1000:

```bash
sudo install -d -m 0700 /opt/auto-agent-actions/secrets
sudo install -d -m 0700 -o 1000 -g 1000 /opt/auto-agent-actions/codex-home
openssl rand -hex 32 | sudo tee /opt/auto-agent-actions/secrets/read-token-broker-secret >/dev/null
sudo chmod 600 /opt/auto-agent-actions/secrets/read-token-broker-secret
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
```

The protected preflight validates non-secret values, required file types/sizes/permissions, the Codex directory owner and `auth.json` metadata, host commands, and the resolved Compose configuration. It does not read or print secret contents. The analysis image build also verifies that the pinned Codex CLI version exposes every isolation/output flag used by the runner. Placeholder files may be used only for early image-build work; the protected preflight and services must not be run with placeholders.

After the GitHub App is created, put its private key and a new webhook secret at the host paths named in `.env.vps`, then run:

```bash
docker compose --env-file .env.vps up -d
docker compose --env-file .env.vps ps
docker compose --env-file .env.vps logs --tail=100 server analysis publisher
```

Confirm the server is healthy from inside its container and that only Caddy publishes host ports. Do not paste logs containing private repository data into public issues.

## Persistence and operations

- Back up the `redis-data` volume after a successful `BGSAVE`; retain and test restore copies off the VPS.
- Back up neither disposable `review-data` worktrees nor the broker socket volume.
- Back up the Codex credential directory only into encrypted storage; prefer re-authentication over broad credential replication.
- Rotate the webhook and broker secrets after suspected exposure. Rotate the GitHub App private key through GitHub and restart the publisher.
- Apply OS and container image updates regularly, rerun the full test/build preflight, and inspect dependency audit results before rollout.
- Monitor restart counts, Redis persistence errors, queue depth, failed jobs, stale-result discards, reconciliation failures, and disk usage.
