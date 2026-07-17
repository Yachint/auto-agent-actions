import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CodexExecutionError,
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
        JSON.stringify({ status: "completed", findings: [], summary: "No findings." }),
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

    expect(review).toEqual({ status: "completed", findings: [], summary: "No findings." });
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
      JSON.stringify({ status: "completed", findings: [], summary: "Stale output" }),
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
          "--",
          "/bin/true",
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
    outputLimitExceeded: false,
  };
}
