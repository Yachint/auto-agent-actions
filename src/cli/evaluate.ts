import { loadReviewIsolationConfig } from "../config/runtime.js";
import { execFileSync } from "node:child_process";
import { reviewPolicyHash } from "../queue/policy.js";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runLocalReview } from "../workflows/local-review.js";
import { scoreReview, type EvaluationLabel } from "../validation/evaluation.js";

// Operator-owned private manifest, never accepted through webhooks or review queues.
const manifestPath = process.argv[2];
const reportPath = process.argv[3];
if (!manifestPath || !reportPath || process.argv.length !== 4)
  throw new TypeError(
    "usage: npm run review:evaluate -- <private-manifest.json> <metrics.json>",
  );
function parsePrivateJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new TypeError("invalid private evaluation JSON");
  }
}
const manifest = parsePrivateJson(await readFile(manifestPath, "utf8")) as {
  model: string;
  reasoningEffort: "high" | "medium" | "low";
  repetitions: number;
  verifyFindings?: boolean;
  adaptiveEffort?: boolean;
  cases: Array<{
    id: string;
    fixture: string;
    bundle: string;
    sha256: string;
    labels: EvaluationLabel[];
  }>;
};
if (
  !/^[a-zA-Z0-9.-]+$/.test(manifest.model) ||
  !["high", "medium", "low"].includes(manifest.reasoningEffort) ||
  !Number.isSafeInteger(manifest.repetitions) ||
  manifest.repetitions < 1 ||
  manifest.repetitions > 20 ||
  (manifest.verifyFindings !== undefined &&
    typeof manifest.verifyFindings !== "boolean") ||
  (manifest.adaptiveEffort !== undefined &&
    typeof manifest.adaptiveEffort !== "boolean") ||
  !Array.isArray(manifest.cases) ||
  manifest.cases.length === 0 ||
  manifest.cases.length > 100
)
  throw new TypeError("invalid evaluation manifest");
const codexBinary = process.env.CODEX_BINARY ?? "codex";
const cliVersion = execFileSync(codexBinary, ["--version"], {
  encoding: "utf8",
  maxBuffer: 1024,
}).trim();
if (!/^codex-cli [0-9]+\.[0-9]+\.[0-9]+$/.test(cliVersion))
  throw new TypeError("invalid evaluation CLI identity");
const isolation = loadReviewIsolationConfig(process.env);
const policyHash = reviewPolicyHash({
  ...process.env,
  CODEX_CLI_VERSION: cliVersion.slice(10),
  REVIEW_ISOLATE_CODEX: String(isolation.sandboxBinary !== undefined),
  CODEX_TIMEOUT_MS: "1800000",
  CODEX_MODEL: manifest.model,
  CODEX_REASONING_EFFORT: manifest.reasoningEffort,
  REVIEW_VERIFY_FINDINGS: String(manifest.verifyFindings ?? false),
  REVIEW_ADAPTIVE_EFFORT: String(manifest.adaptiveEffort ?? false),
});
const base = path.dirname(path.resolve(manifestPath));
const metrics = [];
for (const item of manifest.cases) {
  if (
    !/^[a-zA-Z0-9-]{1,100}$/.test(item.id) ||
    !/^[a-f0-9]{64}$/.test(item.sha256)
  )
    throw new TypeError("invalid evaluation case");
  scoreReview(
    {
      status: "completed",
      blocked_reason: null,
      summary: "validate",
      findings: [],
    },
    item.labels,
  );
  const bundle = path.resolve(base, item.bundle);
  if (
    createHash("sha256")
      .update(await readFile(bundle))
      .digest("hex") !== item.sha256
  )
    throw new TypeError("snapshot content digest mismatch");
  const fixture = parsePrivateJson(
    await readFile(path.resolve(base, item.fixture), "utf8"),
  );
  for (let repetition = 0; repetition < manifest.repetitions; repetition++) {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "aaa-evaluation-"));
    const started = Date.now();
    const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    try {
      const result = await runLocalReview({
        onUsage: (value) => {
          usage.inputTokens += value.inputTokens;
          usage.cachedInputTokens += value.cachedInputTokens;
          usage.outputTokens += value.outputTokens;
        },
        ...isolation,
        fixture,
        codexBinary,
        snapshotPath: bundle,
        dataDirectory,
        model: manifest.model,
        reasoningEffort: manifest.reasoningEffort,
        timeoutMs: 1_800_000,
        schemaPath: fileURLToPath(
          new URL("../codex/review-coverage-schema.json", import.meta.url),
        ),
        instructionsPath: fileURLToPath(
          new URL("../codex/review-instructions.md", import.meta.url),
        ),
        ...(manifest.adaptiveEffort === undefined
          ? {}
          : { adaptiveEffort: manifest.adaptiveEffort }),
        ...(manifest.verifyFindings === undefined
          ? {}
          : { verifyFindings: manifest.verifyFindings }),
      });
      metrics.push({
        caseId: item.id,
        bundleSha256: item.sha256,
        repetition,
        status: "completed",
        usage,
        durationMs: Date.now() - started,
        rejectedAnchors: result.rejected_findings.length,
        ...scoreReview(result.review, item.labels),
      });
    } catch (error) {
      metrics.push({
        caseId: item.id,
        bundleSha256: item.sha256,
        repetition,
        status: "failed",
        durationMs: Date.now() - started,
        errorClass: error instanceof Error ? error.name : "unknown",
      });
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  }
}
await mkdir(path.dirname(path.resolve(reportPath)), {
  recursive: true,
  mode: 0o700,
});
await writeFile(
  reportPath,
  JSON.stringify(
    {
      model: manifest.model,
      cliVersion,
      policyHash,
      isolated: isolation.sandboxBinary !== undefined,
      adaptiveEffort: manifest.adaptiveEffort ?? false,
      effort: manifest.reasoningEffort,
      verification: manifest.verifyFindings ?? false,
      metrics,
    },
    null,
    2,
  ),
  { mode: 0o600, flag: "wx" },
);
process.stdout.write(`Saved ${metrics.length} sanitized evaluation runs\n`);
if (metrics.some((item) => item.status === "failed")) process.exitCode = 1;
