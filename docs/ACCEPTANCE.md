# First-release acceptance status

This document separates locally verified behavior from checks that require the owner's VPS and private GitHub App. The security and product requirements remain authoritative in `docs/PLAN.md`.

## Locally verified

| Criterion | Evidence |
| --- | --- |
| Supported PR webhooks enqueue durable work exactly once | Webhook signature/action/allowlist tests, Redis delivery claims, BullMQ job IDs, and queue idempotency tests |
| GitHub App connectivity/lifecycle can be acknowledged without queueing review work | Signed `ping`, `installation`, and `installation_repositories` webhooks return 200; invalid signatures still fail closed |
| New commits supersede old heads without stale publication | Atomic review-state tests and the privileged analysis-to-publication handoff integration test |
| Invalid signatures, forks, drafts, closed PRs, and repositories outside the allowlist fail closed | Webhook, analysis, publisher, and reconciliation tests |
| Codex runs non-interactively with trusted model, effort, prompt, instructions, schema, timeout, output limits, and read-only sandbox settings | Runner, prompt, local workflow, Landlock selection, Compose-boundary, and startup write-denial tests |
| Codex receives no GitHub token or unrelated environment secret | Environment allowlist tests and the separate publisher-side read-token broker boundary |
| GitHub App private key is absent from the analysis configuration/process | Runtime configuration tests and separate entry-point dependency boundaries |
| Private Git fetch credentials are not persisted in URLs, arguments, config, or helper files | Repository manager authentication tests |
| Only exact right-side changed lines can be published | Exact diff parser, output validator, persisted publication-payload validator, and publisher tests |
| Reviews with publishable P0/P1 findings use `REQUEST_CHANGES`; P2/P3 are advisory; successful zero-finding reviews post a visible `COMMENT` summary | REST client, publisher, and privileged-handoff tests |
| A blocked or incomplete Codex inspection cannot enter the publication queue | Structured-output, runner, and persisted publication-payload tests |
| Missed webhooks are recovered | Reconciliation processor tests using the same durable queue/state idempotency path |
| Reconciliation cannot reset terminal analysis attempts | Exhaustion-gate scheduling/execution tests and live Redis acceptance across reconciliation, store recreation, and job-retention loss |
| Opt-in grouped review resumes completed inspections without publishing partial results | In-memory checkpoint/quota/cancellation/corruption tests and workflow integration tests requiring candidate verification after resume |
| Crashed worktrees are cleaned without path escape | Repository cleanup tests |
| Runtime state, readiness, queue gauges, and operational counters are available without public metrics exposure | Redis state, app, metrics, and machine-checked Traefik/Compose routing boundaries |
| Production dependencies have no currently reported npm advisory | `npm audit --omit=dev` and the full `npm audit` reported 0 vulnerabilities on 2026-09-02 after updating the lockfile to patched transitive releases |

The 2026-09-30 update passed TypeScript build and 177 tests under Node 24, including opt-in real Redis/BullMQ recovery, Unix-socket and native isolation tests. Both runtime images build. Codex CLI 0.155.1 passes strict configuration, hardened read-only preflight and a synthetic isolated diff-inspection/write-denial/coverage canary. Full dependency audit reports zero vulnerabilities on this date. These checks use synthetic fixtures and no private App or live model calls. See [PIPELINE_V2.md](PIPELINE_V2.md) for current recovery semantics, optional features, limits and coordinated migration requirements.

## Owner/VPS verification required

1. Deliver a signed test webhook against the new release, open a same-repository PR with a publishable finding, and verify exactly one correctly anchored `REQUEST_CHANGES` review against the current head. Then verify a clean new head receives a summary-only `COMMENT`.
2. Push a replacement commit during a deliberately slow review and verify no review is posted for the obsolete SHA.
3. Stop webhook delivery temporarily, push a commit, restore the stack, and confirm reconciliation recovers the missed head.
4. Rehearse Redis backup and restore.
5. Before enabling a public repository, add and verify host-level egress restrictions for analysis and publisher traffic.

Historical deployment evidence (2026-09-02): the VPS Compose configuration, image build, exact Codex 0.151.0 pin, read-only Landlock write-denial probe, containerized ChatGPT authentication, selected-repository GitHub App installation, restricted mounts/capabilities, internal readiness, and zero-restart startup were reverified on 2026-09-02.


The September 30 code was subsequently deployed. The October 6 incident fixes through `6b997ed` passed live Redis exhaustion/cooldown acceptance and isolated synthetic Git/write-denial probes. Small real-model Git and tool-output challenge probes passed, but the full 123-path Agenda review remained blocked and analysis was stopped to preserve account usage. The owner-approved `bb6c12c` trial enabled groups of 16, but reached its 65% account-usage ceiling before any group completion was logged. Analysis was stopped; the interrupted job remains delayed after one attempt. Completing that review and live checkpoint-resume acceptance remain outstanding. Retarget/in-flight push races, ambiguous review POST recovery, and optional Checks/comment authorization still require owner/VPS verification. Per-job cgroup termination and closed-repository mirror/state retention remain future operational work; filesystem metadata is not hidden by the native boundary, and port-only TCP filtering requires host egress rules against same-port remote destinations.
