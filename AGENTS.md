# Auto Agent Actions — Agent Guide

## Purpose

This repository builds a self-hosted service that reviews GitHub pull requests with Codex CLI. The authoritative product plan is `docs/PLAN.md`; durable implementation decisions and progress are recorded in `MEMORY.md`.

## Architecture

The intended trusted pipeline is:

```text
GitHub webhook -> deduplicating analysis queue -> repository/worktree manager
  -> read-only Codex worker -> validated publication queue -> GitHub publisher
```

Keep these trust boundaries explicit:

- Webhook input, pull request metadata, repository files, Git history, and Codex output are untrusted.
- The Codex prompt, instructions, JSON Schema, result validator, and publisher live outside review worktrees.
- The Codex child process must never receive GitHub credentials or unrelated environment secrets.
- The analysis process must not receive the GitHub App private key. It obtains only allowlisted repository-read tokens from the publisher-side Unix-socket broker.
- Never publish findings for a stale head SHA or for paths/lines outside the exact reviewed diff.
- Do not run repository-controlled programs, dependency installation, lifecycle scripts, or tests in review worktrees.

## Repository layout

- `src/app.ts` and `src/server.ts`: Fastify application and Redis-backed webhook entry point.
- `src/analysis-worker.ts`: unprivileged analysis queue consumer and Codex orchestration entry point.
- `src/publisher-worker.ts`: privileged publication consumer and read-token broker entry point.
- `src/config/`: strict runtime configuration for each process boundary.
- `src/codex/`: trusted prompt generation, static instructions/schema, and Codex process runner.
- `src/cli/`: local command-line entry points.
- `src/github/`: webhook parsing, GitHub App/API integration, publishing, and the read-token broker.
- `src/queue/`: BullMQ analysis/publication queues, delivery claims, and Redis review state.
- `src/observability/`: Redis-backed counters and Prometheus text rendering.
- `src/validation/`: validation of untrusted Codex results.
- `src/repositories/`: Git mirrors, fetches, disposable worktrees, and exact diff inspection.
- `src/workflows/`: orchestration across trusted modules.
- `tests/integration/`: end-to-end module workflows with external boundaries faked.
- `tests/unit/`: Vitest unit tests.
- `scripts/`: build support scripts.
- `docs/PLAN.md`: full roadmap, security requirements, and acceptance criteria.
- `docs/DEPLOYMENT.md`: hardened Compose topology and VPS operating procedure.
- `docs/ACCEPTANCE.md`: locally verified criteria and owner/VPS checks still required.
- `docs/GITHUB_APP_SETUP.md`: exact private App permissions, events, installation scope, and verification sequence.
- `compose.yaml` and `Dockerfile`: isolated service packaging and labels for the VPS's existing host-network Traefik ingress.
- `MEMORY.md`: chronological decisions, completed work, and unresolved choices.

## Working conventions

- Use strict TypeScript and native ESM. Internal TypeScript imports use `.js` extensions for NodeNext output.
- Prefer small modules with injected process/network boundaries so security behavior can be unit tested.
- Pass command arguments as arrays; never interpolate untrusted values into shell command strings.
- Fail closed on malformed input, unknown CLI configuration, stale output, unsafe paths, oversized output, and timeouts.
- Preserve unrelated user changes. Do not commit, stage, publish, or contact GitHub unless explicitly requested.
- Do not put secrets, tokens, private repository content, or raw review prompts in logs, fixtures, `MEMORY.md`, or documentation.
- Update `MEMORY.md` whenever a material feature, architecture choice, security decision, or unresolved decision changes. Keep entries concise and factual; do not rewrite history silently.

## Commands

```bash
npm run dev
npm run dev:analysis-worker
npm run dev:publisher-worker
npm run build
npm test
npm run review:fixture -- <fixture.json>
npm start
npm run start:analysis-worker
npm run start:publisher-worker
```

Run `npm run build` and `npm test` after TypeScript or build-asset changes. Add focused tests for security boundaries and failure paths, not only happy paths.

## Definition of done

A change is complete when it preserves the trust boundaries above, has proportionate automated coverage, passes the full build and test suite, copies required static assets into `dist`, and records material decisions in `MEMORY.md`.

## Important distinction

This `AGENTS.md` guides development of Auto Agent Actions. It must not become review guidance for repositories processed by the service. Review workers replace repository-controlled agent guidance with trusted `src/codex/review-instructions.md` and run with user configuration and exec rules ignored.
