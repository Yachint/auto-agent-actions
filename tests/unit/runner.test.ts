import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildCodexArgs,
  CodexExecutionError,
  executeProcess,
  runCodexReview,
  verifyCodexReadOnlySandbox,
  type ProcessExecutor,
  type ProcessInvocation,
  type ProcessResult,
} from "../../src/codex/runner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Codex review runner", () => {
  it("uses a locked-down invocation and validates the output", async () => {
    const fixture = await createFixture();
    let capturedInvocation: ProcessInvocation | undefined;
    const executor: ProcessExecutor = async (invocation) => {
      capturedInvocation = invocation;
      await writeFile(
        fixture.outputPath,
        JSON.stringify({
          status: "completed",
          findings: [],
          summary: "No findings.",
          blocked_reason: null,
        }),
      );
      return successfulResult();
    };

    const review = await runCodexReview({
      ...fixture,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      prompt: "Trusted review prompt",
      timeoutMs: 60_000,
      executor,
      environment: {
        PATH: "/usr/bin",
        CODEX_API_KEY: "codex-secret",
        GITHUB_TOKEN: "must-not-leak",
        NODE_OPTIONS: "--require=must-not-leak",
      },
    });

    expect(review).toEqual({
      status: "completed",
      findings: [],
      summary: "No findings.",
      blocked_reason: null,
    });
    expect(capturedInvocation).toBeDefined();
    expect(capturedInvocation?.stdin).toBe("Trusted review prompt");
    expect(capturedInvocation?.args.at(-1)).toBe("-");
    expect(capturedInvocation?.args).toContain("read-only");
    expect(capturedInvocation?.args).toContain("--ephemeral");
    expect(capturedInvocation?.args).toContain("--ignore-user-config");
    expect(capturedInvocation?.args).toContain("--ignore-rules");
    expect(capturedInvocation?.args).toContain("--strict-config");
    expect(capturedInvocation?.args).toContain('approval_policy="never"');
    expect(capturedInvocation?.args).toContain('web_search="disabled"');
    expect(capturedInvocation?.args).toContain("features.apps=false");
    expect(capturedInvocation?.args).toContain('model_reasoning_effort="high"');
    expect(capturedInvocation?.args).toContain(
      `model_instructions_file=${JSON.stringify(fixture.instructionsPath)}`,
    );
    expect(capturedInvocation?.environment).toEqual({
      PATH: "/usr/bin",
      CODEX_API_KEY: "codex-secret",
    });
  });

  it("removes stale output before starting Codex", async () => {
    const fixture = await createFixture();
    await writeFile(
      fixture.outputPath,
      JSON.stringify({
        status: "completed",
        findings: [],
        summary: "Stale output",
        blocked_reason: null,
      }),
    );

    await expect(
      runCodexReview({
        ...fixture,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        prompt: "Trusted review prompt",
        timeoutMs: 60_000,
        executor: async () => successfulResult(),
      }),
    ).rejects.toThrow(/did not produce a review output file/);
  });

  it("fails closed when the process times out", async () => {
    const fixture = await createFixture();

    await expect(
      runCodexReview({
        ...fixture,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        prompt: "Trusted review prompt",
        timeoutMs: 1,
        executor: async () => ({
          ...successfulResult(),
          exitCode: null,
          signal: "SIGTERM",
          timedOut: true,
        }),
      }),
    ).rejects.toThrow(CodexExecutionError);
  });

  it("accepts a valid review when bounded process diagnostics were truncated", async () => {
    const fixture = await createFixture();

    await expect(
      runCodexReview({
        ...fixture,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        prompt: "Trusted review prompt",
        timeoutMs: 60_000,
        executor: async () => {
          await writeFile(
            fixture.outputPath,
            JSON.stringify({
              status: "completed",
              findings: [],
              summary: "No findings.",
              blocked_reason: null,
            }),
          );
          return {
            ...successfulResult(),
            stdout: "bounded diagnostic prefix",
            outputTruncated: true,
          };
        },
      }),
    ).resolves.toEqual({
      status: "completed",
      findings: [],
      summary: "No findings.",
      blocked_reason: null,
    });
  });

  it("drains and discards process output beyond the diagnostic capture limit", async () => {
    const result = await executeProcess({
      command: process.execPath,
      args: [
        "-e",
        'process.stdout.write("x".repeat(4096)); process.stderr.write("y".repeat(4096));',
      ],
      stdin: "",
      environment: process.env,
      timeoutMs: 10_000,
      maxOutputBytes: 128,
    });

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.outputTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBe(
      128,
    );
  });

  it("still rejects an oversized structured review output file", async () => {
    const fixture = await createFixture();

    await expect(
      runCodexReview({
        ...fixture,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        prompt: "Trusted review prompt",
        timeoutMs: 60_000,
        maxReviewOutputBytes: 32,
        executor: async () => {
          await writeFile(fixture.outputPath, "x".repeat(33));
          return successfulResult();
        },
      }),
    ).rejects.toThrow(/review output exceeded 32 bytes/);
  });

  it("fails closed when Codex reports that repository inspection was blocked", async () => {
    const fixture = await createFixture();
    await expect(
      runCodexReview({
        ...fixture,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        prompt: "Trusted review prompt",
        timeoutMs: 60_000,
        executor: async () => {
          await writeFile(
            fixture.outputPath,
            JSON.stringify({
              status: "blocked",
              findings: [],
              summary: "The review could not be completed.",
              blocked_reason: "The filesystem sandbox was unavailable.",
            }),
          );
          return successfulResult();
        },
      }),
    ).rejects.toThrow(/could not complete/);
  });

  it("runs a real Codex read-only sandbox smoke command before worker startup", async () => {
    let capturedInvocation: ProcessInvocation | undefined;
    await verifyCodexReadOnlySandbox({
      codexBinary: "codex-test",
      environment: { PATH: "/usr/bin", GITHUB_TOKEN: "must-not-leak" },
      executor: async (invocation) => {
        capturedInvocation = invocation;
        return successfulResult();
      },
    });

    expect(capturedInvocation).toEqual(
      expect.objectContaining({
        command: "codex-test",
        args: [
          "sandbox",
          "-c",
          'sandbox_mode="read-only"',
          "-c",
          "features.use_legacy_landlock=true",
          "--",
          "/bin/sh",
          "-c",
          "if /bin/sh -c ': > /tmp/auto-agent-actions-sandbox-write-probe'; then rm -f /tmp/auto-agent-actions-sandbox-write-probe; exit 1; else exit 0; fi",
        ],
        environment: { PATH: "/usr/bin" },
      }),
    );
  });

  it("rejects worker startup when the Codex read-only sandbox is unavailable", async () => {
    await expect(
      verifyCodexReadOnlySandbox({
        executor: async () => ({
          ...successfulResult(),
          exitCode: 1,
          stderr: "bwrap: permissions denied\n",
        }),
      }),
    ).rejects.toThrow(
      /sandbox preflight failed: bwrap: permissions denied/,
    );
  });

  it("rejects worker startup when sandbox preflight diagnostics are truncated", async () => {
    await expect(
      verifyCodexReadOnlySandbox({
        executor: async () => ({
          ...successfulResult(),
          outputTruncated: true,
        }),
      }),
    ).rejects.toThrow(/diagnostic output limit exceeded/);
  });

  it("forces the Landlock backend for review commands", () => {
    const args = buildCodexArgs({
      worktreePath: "/tmp/worktree",
      schemaPath: "/trusted/review-schema.json",
      instructionsPath: "/trusted/review-instructions.md",
      outputPath: "/trusted/review-output.json",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });

    expect(args).toContain("features.use_legacy_landlock=true");
  });

  it("requires trusted artifacts and output to be outside the worktree", async () => {
    const fixture = await createFixture();
    const unsafeSchemaPath = path.join(fixture.worktreePath, "schema.json");
    await writeFile(unsafeSchemaPath, "{}");

    await expect(
      runCodexReview({
        ...fixture,
        schemaPath: unsafeSchemaPath,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        prompt: "Trusted review prompt",
        timeoutMs: 60_000,
        executor: async () => successfulResult(),
      }),
    ).rejects.toThrow(/schemaPath must be outside/);
  });
});

async function createFixture(): Promise<{
  worktreePath: string;
  schemaPath: string;
  instructionsPath: string;
  outputPath: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "auto-agent-actions-"));
  temporaryDirectories.push(root);
  const worktreePath = path.join(root, "worktree");
  const trustedPath = path.join(root, "trusted");
  await mkdir(worktreePath);
  await mkdir(trustedPath);

  const schemaPath = path.join(trustedPath, "review-schema.json");
  const instructionsPath = path.join(trustedPath, "review-instructions.md");
  await writeFile(schemaPath, "{}");
  await writeFile(instructionsPath, "Trusted instructions");

  return {
    worktreePath,
    schemaPath,
    instructionsPath,
    outputPath: path.join(trustedPath, "review-output.json"),
  };
}

function successfulResult(): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    outputTruncated: false,
  };
}
