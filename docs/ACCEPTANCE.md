# First-release acceptance status

This document separates locally verified behavior from checks that require the owner's VPS and private GitHub App. The security and product requirements remain authoritative in `docs/PLAN.md`.

## Locally verified

| Criterion | Evidence |
| --- | --- |
| Supported PR webhooks enqueue durable work exactly once | Webhook signature/action/allowlist tests, Redis delivery claims, BullMQ job IDs, and queue idempotency tests |
| GitHub App connectivity/lifecycle can be acknowledged without queueing review work | Signed `ping`, `installation`, and `installation_repositories` webhooks return 200; invalid signatures still fail closed |
| New commits supersede old heads without stale publication | Atomic review-state tests and the privileged analysis-to-publication handoff integration test |
| Invalid signatures, forks, drafts, closed PRs, and repositories outside the allowlist fail closed | Webhook, analysis, publisher, and reconciliation tests |
| Codex runs non-interactively with trusted model, effort, prompt, instructions, schema, timeout, output limits, and read-only sandbox settings | Runner, prompt, local workflow, and startup sandbox-preflight tests |
| Codex receives no GitHub token or unrelated environment secret | Environment allowlist tests and the separate publisher-side read-token broker boundary |
| GitHub App private key is absent from the analysis configuration/process | Runtime configuration tests and separate entry-point dependency boundaries |
| Private Git fetch credentials are not persisted in URLs, arguments, config, or helper files | Repository manager authentication tests |
| Only exact right-side changed lines can be published | Exact diff parser, output validator, persisted publication-payload validator, and publisher tests |
| Reviews use advisory `COMMENT` only; successful zero-finding reviews post a visible summary | Publisher tests |
| A blocked or incomplete Codex inspection cannot enter the publication queue | Structured-output, runner, and persisted publication-payload tests |
| Missed webhooks are recovered | Reconciliation processor tests using the same durable queue/state idempotency path |
| Crashed worktrees are cleaned without path escape | Repository cleanup tests |
| Runtime state, readiness, queue gauges, and operational counters are available without public metrics exposure | Redis state, app, metrics, and machine-checked Traefik/Compose routing boundaries |
| Production dependencies have no currently reported npm advisory | `npm audit --omit=dev` reported 0 vulnerabilities on 2026-07-16 |

The latest local verification completed with `npm run build` and 121 passing standard tests. One real Unix-socket integration test is opt-in because the normal development sandbox forbids sockets; it was run outside that sandbox and passed previously.

## Owner/VPS verification required

1. Run `docker compose --env-file .env.vps config`, build all images on the VPS, and verify the explicit Codex read-only sandbox smoke command passes.
2. Authenticate the pinned containerized Codex CLI into the dedicated `CODEX_HOME` and confirm `codex login status` without exposing `auth.json`.
3. Create and install the private GitHub App on selected repositories with Contents read, Pull requests read/write, Metadata read, and the `pull_request` webhook.
4. Configure the generated private key and webhook secret, start the stack, and confirm no project service publishes host ports and Traefik exposes only the exact webhook path.
5. Deliver a signed test webhook, open a same-repository PR, and verify exactly one correctly anchored `COMMENT` review against the current head.
6. Push a replacement commit during a deliberately slow review and verify no review is posted for the obsolete SHA.
7. Stop webhook delivery temporarily, push a commit, restore the stack, and confirm reconciliation recovers the missed head.
8. Inspect logs and container environments/mounts for credential separation, then rehearse Redis backup and restore.
9. Before enabling a public repository, add and verify host-level egress restrictions for analysis and publisher traffic.
