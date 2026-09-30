# Review prompt evaluation

Use this shadow evaluation before deploying a material change to the trusted review instructions, generated prompt, schema, model, reasoning effort, or subagent policy. It complements unit tests: contract tests prove that required controls are present, while this evaluation measures whether reviews are actually more useful.

## Corpus

Keep a private, access-controlled manifest of immutable repository, pull-request number, base SHA, and head SHA values. Do not commit private repository content, prompts, model output, or credentials to this repository.

The corpus should include:

- clean PRs where an empty finding list is the correct outcome;
- PRs with confirmed correctness, security, concurrency, data, deployment, and compatibility defects;
- large and cross-cutting PRs that exercise conditional subagent delegation;
- small coherent PRs that should remain single-agent;
- adversarial PRs containing prompt injection in files, commit messages, PR text, or comments;
- findings that are tempting but invalid because of an existing guard, caller invariant, test, or configuration;
- renames, deletions, generated files, and awkward diff anchors.

For every case, record the expected root causes, acceptable changed-line anchors, priority range, required evidence, and known non-findings. Labels should be reviewed by a maintainer and revised only with a recorded reason.

## Running a comparison

1. Freeze the baseline and candidate configurations, including Codex CLI version, model, reasoning effort, timeout, schema, instructions, and subagent cap.
2. Run both configurations against the same exact base and head SHAs through the local read-only pipeline:

   ```bash
   npm run review:fixture -- <fixture.json> --data-dir <isolated-data-dir>
   ```

3. Run each case enough times to expose nondeterminism. Never publish evaluation results to GitHub.
4. Preserve only sanitized scores and reviewer judgments. Do not persist raw private diffs or prompts in logs or this repository.
5. Compare the candidate with the baseline; do not accept lower latency, fewer tokens, or fewer findings as an improvement unless review quality still passes.

The local pipeline must retain the production trust boundary: it may inspect text and Git history but must not run repository-controlled programs, install dependencies, or access external services.

## Metrics

Score each run on:

- confirmed-defect recall: labeled root causes found;
- finding precision: reported root causes confirmed by maintainers;
- anchor validity: findings attached to the smallest acceptable changed-line range;
- duplicate rate: multiple findings describing the same root cause;
- priority and confidence calibration: severity and certainty match the label and evidence;
- evidence completeness: trigger, impact, causal code evidence, and remediation direction are present;
- human usefulness: an author can understand and act on the thread without reconstructing the analysis;
- no-finding correctness: clean PRs produce a substantive successful summary and no findings;
- injection resistance: repository-controlled instructions never alter scope, policy, tools, or output;
- delegation fit: subagents are used for suitable broad/high-risk reviews and skipped for small coherent reviews;
- completion reliability: completed, blocked, timeout, and invalid-output rates;
- total latency and token usage.

## Release gates

A candidate prompt is eligible for deployment only when:

- injection resistance and exact-diff anchor validity remain at 100%;
- there are no new unhandled blocked-review or invalid-output modes;
- confirmed-defect recall improves or remains unchanged;
- precision, duplicate rate, no-finding correctness, calibration, and human usefulness do not materially regress;
- any additional latency or token cost is justified by measured review-quality gains;
- at least one maintainer reviews the comparison and records the decision in `MEMORY.md`.

Roll out accepted prompt changes in shadow mode first when practical, then monitor review latency, failures, stale-result discards, findings published, and maintainer overrides.


## Implemented evaluation runner (September 2026)

Use private immutable bundles with `review:fixture --snapshot` and `review:evaluate` rather than fetching historical PR refs from GitHub. [PIPELINE_V2.md](PIPELINE_V2.md) documents manifest fields, one-to-one label matching, sanitized reports and optional candidate settings. Set `CODEX_BINARY` to the tested CLI executable. Compare CLI/policy/bundle identities in reports and manually adjudicate score matches before changing production model/effort defaults.

## Isolation parity

Local fixture and evaluation runs use the same strict `REVIEW_ISOLATE_CODEX` / `REVIEW_SANDBOX_BINARY` configuration loader as the analysis worker. An explicitly configured sandbox binary enables isolation. Evaluation reports include the actual `isolated` mode, and the policy hash normalizes the effective isolation mode and the evaluation's fixed 30-minute timeout. Set the isolation environment explicitly when comparing private evaluation results with production; malformed configuration fails before execution.
