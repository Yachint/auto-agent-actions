# Large-PR review diagnosis — 2026-10-07

## Conclusion

The original uncontrolled retry incident and the current incomplete review have different causes. Exhaustion fencing and quota cooldown address the retry loop. The latest current-head attempts were instead terminated by operator-added model-budget caps. Large-PR size is real, but file-count partitioning, repeated context and a small whole-job cap make this deployment inefficient and unable to finish its configured review normally.

This is an evidence-backed diagnosis, not a completed scalability fix or a successful review. Production analysis remains stopped. No live model calls were made during this investigation, and no Agenda files were modified.

## Evidence from the current frozen scope

Read-only VPS Git measurements for Agenda PR #16, head `2552dabe5e249f57101da5bb36e0d415f638b35f`, comparison/base `e67a18e46f3c17aeecf34f2db65187f7ec4008fe`:

| Measurement | Result |
| --- | ---: |
| Changed paths | 124 |
| Added / removed lines | 17,339 / 769 |
| Patch bytes, 12 surrounding lines | 1,530,535 |
| Patch bytes, 3 surrounding lines | 1,183,650 |
| Patch bytes, zero surrounding lines | 1,023,487 |
| Group ten, four paths / 12-line context | 84,378 bytes; 1,871 patch lines |
| Largest four-path group | 200,328 bytes |

Three-line context reduces patch bytes by approximately 22.7% while retaining every added/deleted line. This alone is not sufficient: callers, guards and semantic context still require targeted reads. The measured scope includes 74 other-source paths (717,643 patch bytes), 40 test-related paths (563,053 bytes), nine documentation paths (248,148 bytes), and one JSON path. No lockfiles or binary assets were classified in this scope; skipping those would not solve this case. Categories are coarse path-pattern classifications, not a semantic assessment.

Safe numeric telemetry from the seven current-head attempts records 80 upstream requests, 1,509,843 gross input tokens, 72,448 cached input tokens (4.8%), and 8,887 output tokens. Their upstream request durations sum to 334,377 ms; this is neither total wall time nor a completed-review timing. Every recorded upstream status was 200. Nine groups / 36 paths were saved, with checkpoint reuse confirmed between operator resumes. Whole-attempt caps repeatedly interrupted partially inspected groups and caused their unfinished work to be repeated.

The final attempt inspected group ten only. Eight upstream requests grew from 92,952 to 131,011 encoded request bytes and from 22,275 to 30,555 input tokens per response. Tool-output history grew from zero to 28,984 bytes. Observed total input reached 211,548 tokens, aborting the child at the 200,000-token ceiling with no additional completed group. Seven commands succeeded; no command, dispatch or unsupported-tool failures were reported for this invocation. There is no evidence that a hung model or upstream failure caused this stop. Partial work must not be counted as inspected or published as a clean review.

Account usage was 49% when analysis was stopped. Account percentage includes desktop investigation/chat activity and cannot be derived directly from token counts or API prices.

## Confirmed design problems

1. `runReviewCore` constructs one `ReviewModelBudget` shared by every sequential group and candidate verification. The deployed 24-request / 200,000-input-token limits are whole-attempt ceilings, not per-unit limits. A large review with dozens of units cannot be expected to fit without measurement. Restarting after each cap made caps into ordinary scheduling boundaries and repeatedly lost unfinished-unit work.
2. `runResumableReview` partitions by four paths in Git order. Path count does not track tokens, hunk count, risk or dependency relationships. One unit can be several times larger than another; even one file can need subdivision.
3. `buildGroupReviewContext` preloads up to 64 KiB encoded patches with 12 surrounding lines. Partial patches force additional tool reads. Existing prompt guidance normally limits tool output to 1,000 tokens, creating many small reads; each following model request carries accumulated context. Bounds protect resources but are not a complete review scheduling strategy.
4. Every group starts a new ephemeral CLI invocation and isolated snapshot. The full review guidance and tool/schema context repeat, and cross-group knowledge is not explicitly synthesized before final finding verification. Prompt caching was poor in observed telemetry; the reason is not yet established. No caching defect or predictable subscription-quota savings is claimed.

## Techniques to implement and evaluate

- **Plan by content and dependency, not file count.** Use trusted frozen patch statistics to size units; keep tightly related code/tests together when their combined context fits. Oversized files require hunk-oriented units with exact original line coordinates. All required paths and changed hunks need a coverage ledger; no relevant changes may be silently filtered.
- **Use narrow initial context and targeted retrieval.** Three-line patches are a measured first reduction; fetch exact frozen surrounding ranges/callers when needed. Tune tool-output pagination to the planned unit rather than forcing hundreds of tiny reads. Compare request count and gross/cached input, not just patch bytes.
- **Make one queued review a complete staged run.** Internal units and validated checkpoints are compatible with one end-to-end review job. Unit budgets should detect an individually stuck inspection; a separate bounded, size-aware whole-PR budget should include synthesis/verification. The account spending ceiling remains authoritative. Changing budget semantics must be explicit and validated, not hidden behind retries or removal of limits.
- **Retain cross-component reasoning.** A final bounded pass must examine interactions and independently verify/deduplicate candidate findings. Inspecting isolated units and merely concatenating their summaries can miss integration defects.
- **Measure cache/context behavior before promising savings.** Stable instruction/tool prefixes and supported cache options can improve reuse, but the exact deployed CLI/custom-provider behavior must be checked. Compaction compatibility must also be tested through the restricted provider before relying on a long session; a generic documentation feature is not proof of support in this topology.
- **Keep failures terminal.** No-progress units, malformed results, stale heads, unsafe anchors and quota exhaustion must not trigger repeated unbounded restarts or misleading successful publication. Completed checkpoints remain bound to the correct scope/policy.

## Acceptance sequence

1. Use the exact frozen diff to validate deterministic unit sizes and complete path/hunk assignment without inference; retain only correct compatible checkpoints.
2. Run the full VPS build/test suite with existing images/dependencies and fake inference for budgets, coverage, cancellation, restart recovery and publication boundaries. Add a long-context compaction/proxy compatibility test if the chosen design uses it.
3. Deploy the validated fix with protected configuration/Redis backups. Do not resume the unchanged blocked group.
4. At an eligible usage reset, start one complete current-head review job at medium reasoning / one agent, with no operator resume loop. Record start/end wall time, requests, gross/cached input, output, and account usage sampled at least once/minute. Respect the approved account ceiling even if the run cannot finish within it.
5. Success requires complete exact-scope inspection, cross-component synthesis, candidate verification, exact-diff/current-head validation, publication and the actual GitHub review URL. Report failure honestly if the single run stops; do not infer quality or cost from partial progress.

## Official references and limits of inference

- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching): reusable prompt prefixes and actual cached-token measurements matter; API pricing does not establish ChatGPT subscription allowance consumption.
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference): documents automatic compaction thresholds and tool-output limits. Version/provider compatibility must be validated against the installed CLI; no upgrade is authorized or required by this report.

## Implemented response and offline validation

At the owner's request, the hourly continuation was paused and production analysis remains stopped. The content-unit implementation replaces fixed four-file grouping in staged mode; `REVIEW_BATCH_FILES` now limits paths per unit. A unit contains at most 24 KiB of escaped patch JSON with three surrounding lines. Large hunks and individual long lines are split with original coordinates and exact changed-line anchors. A trusted ledger reconstructs each frozen patch and checks its digest before inference. Static relative-import, implementation/test-name and directory affinity help pack related slices; this heuristic is not a complete dependency graph.

Inspection units have independent request/token ceilings and charge a separate aggregate PR budget. The new defaults are 400 requests, 4,000,000 gross input tokens and 100,000 output tokens per queued staged attempt. These are explicit spending ceilings, not predictions of cost or subscription usage; the approved account ceiling still governs live acceptance. The existing unit/invocation/request-body settings remain configurable. A failed unit or aggregate exhaustion terminates the attempt; no automatic resume loop has been introduced.

One successful queued attempt must finish every assigned unit, a cross-component pass for multi-unit plans (including those with no candidates), and independent verification of candidates in bounded batches. Integration notes retain every unit identity and path; shortened summaries are marked and are only leads for frozen-code investigation. Verification cannot introduce or modify candidates. Scope/current-head/publication gates remain enforced. Content-unit checkpoint identities intentionally reject old file-group checkpoints; existing checkpoints are preserved rather than claimed as compatible coverage.

The final full VPS build and test run passed all 284 tests, including Redis, Unix sockets, native isolation and a real Codex child with fake inference. A deterministic planner dry run on the frozen scope above represented all 124 paths in 68 units / 142 slices, with 16 paths split across slices. Encoded units ranged from 1,979 to 24,576 bytes (mean 19,308); all 1,183,650 raw patch bytes were represented. Planning took 1,381 ms. This is complete assignment, not completed model inspection or a measured review time. No local builds/tests, installations, Agenda edits or production model calls were performed.

Runtime promotion and one monitored current-head review remain the acceptance steps. Keep medium effort and one agent. Do not claim a successful review, quota savings or caching improvement before that run completes and its actual GitHub review URL is confirmed.

## Deployed acceptance result — incomplete review

Promoted VPS-tested commit `fcc4603` with matching immutable application/analysis image IDs, protected configuration and Redis backups, and coordinated application restarts. Read-only and native isolation preflights and required static-asset reads passed. Persistent settings remain GPT-6.1 Sol, medium effort, one agent, maximum four paths per content unit, 16 requests per invocation and 128 KiB request bodies. Unit ceilings are 24 requests / 200,000 gross input / 10,000 output; aggregate ceilings are 400 requests / 4,000,000 input / 100,000 output.

PR #16 advanced twice during preparation. The actual inference scope was head `6fcb0fe15a6f50e843619152e1ec3cf6f3ff9312`, base `e67a18e46f3c17aeecf34f2db65187f7ec4008fe`, with 69 units. GitHub still matched this scope at the final check. The hourly continuation remains paused.

The acceptance did **not** complete or publish a review. It saved 22 of 69 protected, validated checkpoints (14,483 bytes; two unverified candidates). Analysis is stopped, the scope is exhausted, and active analysis jobs are zero; server, publisher and Redis remain running on the matching deployment. Partial inspection and candidates do not satisfy full review acceptance.

| Measurement | Result |
| --- | ---: |
| Account usage before deployment / before analysis / final stop | 16% / 20% / 66% |
| Gross input / reported cached input | 1,418,503 / 87,552 tokens (6.2%) |
| Observed output | 14,650 tokens |
| Requests / responses with observed usage | 108 / 106 |
| Active attempt elapsed time, summed | 747,967 ms (about 12.5 minutes) |
| Upstream durations, summed | 713,531 ms |
| Largest encoded request | 91,752 bytes |
| Non-200 upstream responses | 0 |

Account percentages include desktop/chat/deployment investigation and are not an isolated reviewer-cost measure. Two interrupted requests have unobserved usage, so token totals are incomplete. Elapsed figures cover incomplete attempts, not a complete-review duration.

The first stop was an operator-monitor error: a four-second shift in the reported reset timestamp was mistaken for a new usage window. The monitor was corrected to tolerate small timestamp jitter (60 seconds), and one explicitly authorized correction resumed the unchanged scope with all 19 prior checkpoints reused. The second stop was the agreed 66% account ceiling. Thus this is two attempts with one correction, not a successful single-attempt benchmark. In-flight cancellation failed closed as unobserved usage; no repeated automatic resume was enabled.

A network-isolated, three-request synthetic Codex tool-loop check preserved its supplied input prefix and instructions. The pinned CLI supplied a cache key but no explicit cache options; official OpenAI documentation describes automatic implicit caching, so absence of an explicit setting does not establish a cache defect. The cause of low live cache reuse remains unproven.

The earlier budget/scheduling fix is deployed, but acceptable large-PR cost is unverified. The next investigation must measure prefix stability and repeated supporting-code retrieval in real requests using content-free metadata, then reduce redundant investigation/context while retaining complete coverage, independent verification and exact-head publication. Do not raise ceilings or resume the unchanged scope repeatedly as a substitute for that fix. No further production run is eligible in this acceptance window.

## Contextual child-review implementation

The next implementation forms bounded dependency neighborhoods before packing patch units. The trusted parent reads frozen head text once for static relative imports and declaration/test navigation, including imports absent from patch context. Import edges, implementation/test names and directory affinity form heuristic chunks capped by `REVIEW_BATCH_FILES`; they are not a complete dependency graph or executable repository guidance. Large patches prefer hunk/declaration cut points while retaining every character, original coordinates and reconstruction/digest checks.

Each independent CLI child receives only its assigned patch slices (at most 24 KiB encoded JSON) and an escaped, support-only chunk brief (at most 6 KiB). Briefs identify related members, frozen source digests, bounded navigation and cross-chunk leads, explicitly marking omissions. Supporting members never count as inspected coverage or eligible finding anchors. The parent constructs these hints without model calls or execution of target code. Changed source/brief data participates in the unit identity; `contextual-units-v3` preserves old checkpoints but does not reuse incompatible inspections.

Stage responsibilities now distinguish local evidence-backed inspection, cross-component investigation and independent candidate disproof. Whole-PR reconnaissance and exhaustive independent verification need not be repeated in every specialist. The integration pass still runs for multi-unit plans with zero candidates; every candidate still passes independent verification, exact-diff validation and current-head publication gates. Children remain sequential and isolated, with unchanged medium effort, one agent, request/unit/PR spending ceilings and terminal failures. Concurrent execution has not been enabled or claimed to save quota.

The complete VPS build/static-assets and all 298 tests passed using existing Docker images and dependencies, including Redis, Unix sockets, native isolation and fake-inference CLI boundaries. A read-only dry plan for frozen head `6fcb0fe15a6f50e843619152e1ec3cf6f3ff9312` and base `e67a18e46f3c17aeecf34f2db65187f7ec4008fe` represented all 125 current exact-diff paths / 1,193,506 raw patch bytes in 39 chunks / 77 units / 144 slices. Maximum chunk membership was four paths; maximum patch JSON was 24,520 bytes and maximum brief 6,076 bytes. Briefs totalled 289,765 bytes across invocations; planning took 1,430 ms without inference. These fresh exact-diff numbers supersede earlier recorded planner counts for acceptance accounting.

This validates assignment and boundaries, not usage savings, model-review quality or completion. More units and added brief data can increase cost; only a complete monitored current-head run can establish whether reduced rediscovery offsets that overhead. The hourly continuation stays paused and analysis remains stopped during preparation. No local builds/tests, installations or Agenda edits occurred.

## Contextual live acceptance — stopped at the owner’s ceiling

The owner authorized a single manual run with a temporary 90% five-hour account ceiling. The PR advanced before inference to head `556967f7748a370eb08ae50d6919bb450a1a6b08`; the older queued scope was discarded without model calls. One model attempt completed 41 of 77 contextual inspections, preserving 34,700 bytes of validated mode-protected checkpoints and four unverified candidate records. Integration, independent candidate verification and successful publication did not complete.

| Measurement | Result |
| --- | ---: |
| Initial account usage / stop request / meter after shutdown | 23% / 90% / 91% |
| Requests | 167 |
| Observed gross / cached input | 2,323,481 / 178,560 tokens (7.7%) |
| Observed output | 27,394 tokens |
| Completed / required inspections | 41 / 77 |

One final inspection completed during shutdown. Account percentages include this chat and all shared-account activity; they are not an isolated reviewer-cost attribution. The account monitor polled more frequently near the ceiling. An early monitoring timeout incorrectly triggered a stop request, which automatic approval review rejected because the meter was below the ceiling and no review failure had been established. The worker was not interrupted; the watcher was corrected to handle slow SSH responses and the same model attempt continued. No operator resume loop or source/configuration change occurred during inference.

The actual stop surfaced as a timeout and left an inactive automatic retry. The exact stopped scope was explicitly exhausted and that retry removed, preserving all completed checkpoints and leaving zero active jobs. Analysis is stopped, application/publisher remain running, and the hourly continuation remains paused. GitHub metadata showed no successful review submitted by this run. Partial candidate records cannot be reported as verified findings.

The contextual design remains insufficient to establish affordable completion for this PR in the tested allowance. Gross input and supporting-read round trips remain high, and observed cache reuse remains low. Those measurements justify further investigation; they do not prove a cache implementation defect or a measured savings regression against a different frozen head/unit plan. Do not restart this unchanged exhausted scope as a substitute for a cost fix.
