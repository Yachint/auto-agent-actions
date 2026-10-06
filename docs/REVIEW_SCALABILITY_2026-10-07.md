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
