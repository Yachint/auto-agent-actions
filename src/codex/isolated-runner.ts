import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  realpath,
  access,
} from "node:fs/promises";
import path from "node:path";
import { createGitExecutor } from "../repositories/git.js";
import { createModelProxy, ModelAuthenticationError } from "./model-proxy.js";
import {
  executeProcess,
  runCodexReview,
  type CodexRunnerOptions,
} from "./runner.js";

/** Job-local Git history and model capability; broker, Redis and sibling files are not readable. */
export async function runIsolatedReview(
  options: CodexRunnerOptions & {
    baseSha: string;
    headSha: string;
    sandboxBinary: string;
  },
) {
  const source = options.environment ?? process.env;
  const credentials = await modelCredentials(source);
  const root = await mkdtemp(
    path.join(path.dirname(options.outputPath), "isolated-"),
  );
  const git = createGitExecutor();
  const refs = `refs/auto-agent-actions/isolation/${randomUUID()}`;
  const bundle = path.join(root, "snapshot.bundle");
  const snapshot = path.join(root, "repository");
  const proxy = await createModelProxy({
    model: options.model,
    timeoutMs: options.timeoutMs,
    ...(options.onUsage === undefined ? {} : { onUsage: options.onUsage }),
    ...credentials,
  });
  try {
    await mkdir(path.join(root, "home"));
    await mkdir(path.join(root, "codex"));
    await mkdir(path.join(root, "tmp"));
    for (const [ref, sha] of [
      [`${refs}/base`, options.baseSha],
      [`${refs}/head`, options.headSha],
    ]) {
      await git({
        args: ["-C", options.worktreePath, "update-ref", ref!, sha!],
      });
    }
    await git({
      args: [
        "-C",
        options.worktreePath,
        "bundle",
        "create",
        bundle,
        `${refs}/base`,
        `${refs}/head`,
      ],
    });
    await git({ args: ["init", snapshot] });
    await git({
      args: [
        "-C",
        snapshot,
        "fetch",
        "--no-tags",
        "--",
        bundle,
        `${refs}/base:refs/snapshot/base`,
        `${refs}/head:refs/snapshot/head`,
      ],
    });
    await git({
      args: ["-C", snapshot, "checkout", "--detach", options.headSha],
    });
    await rm(bundle);
    const privateOutput = path.join(root, "review.json");
    // The proxy accounts for every model response, including delegated threads.
    // Do not also count the CLI's aggregate usage events.
    const { onUsage: _onUsage, ...runnerOptions } = options;
    const output = await runCodexReview({
      ...runnerOptions,
      worktreePath: snapshot,
      outputPath: privateOutput,
      environment: {
        PATH: source.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: path.join(root, "home"),
        CODEX_HOME: path.join(root, "codex"),
        TMPDIR: path.join(root, "tmp"),
        CODEX_API_KEY: proxy.token,
      },
      executor: async (invocation) => {
        const args = [...invocation.args];
        args.splice(
          args.length - 1,
          0,
          "-c",
          'model_provider="review_proxy"',
          "-c",
          'model_providers.review_proxy.name="Review proxy"',
          "-c",
          `model_providers.review_proxy.base_url=${JSON.stringify(proxy.baseUrl)}`,
          "-c",
          'model_providers.review_proxy.env_key="CODEX_API_KEY"',
          "-c",
          'model_providers.review_proxy.wire_api="responses"',
        );
        return executeProcess({
          ...invocation,
          signal: invocation.signal === undefined
            ? proxy.signal
            : AbortSignal.any([invocation.signal, proxy.signal]),
          command: options.sandboxBinary,
          args: [
            "--connect-port",
            new URL(proxy.baseUrl).port,
            // Legacy Codex opens / read-only when creating its nested ruleset.
            // Permit directory listing only; unrelated file contents stay denied.
            "--list",
            "/",
            "--read",
            "/usr",
            "--read",
            "/bin",
            "--read",
            "/lib",
            ...((await access("/lib64").then(
              () => true,
              () => false,
            ))
              ? ["--read", "/lib64"]
              : []),
            "--read",
            "/etc/ssl",
            "--write",
            "/dev/null",
            "--read",
            "/dev/urandom",
            "--write",
            root,
            "--read",
            await realpath(options.schemaPath),
            "--read",
            await realpath(options.instructionsPath),
            "--",
            invocation.command,
            ...args,
          ],
        });
      },
    });
    if (proxy.usageLimit()) throw proxy.usageLimit();
    return output;
  } catch (error) {
    if (proxy.usageLimit()) throw proxy.usageLimit();
    if (proxy.authenticationFailed()) throw new ModelAuthenticationError();
    throw error;
  } finally {
    await proxy.close();
    for (const name of ["base", "head"])
      await git({
        args: [
          "-C",
          options.worktreePath,
          "update-ref",
          "-d",
          `${refs}/${name}`,
        ],
      }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

async function modelCredentials(source: NodeJS.ProcessEnv) {
  if (source.CODEX_API_KEY)
    return {
      upstreamUrl: "https://api.openai.com/v1/responses",
      authorization: `Bearer ${source.CODEX_API_KEY}`,
    };
  if (!source.CODEX_HOME)
    throw new TypeError(
      "isolated model access requires CODEX_HOME or CODEX_API_KEY",
    );
  let auth: Record<string, unknown>;
  try {
    auth = JSON.parse(
      await readFile(path.join(source.CODEX_HOME, "auth.json"), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    throw new ModelAuthenticationError();
  }
  if (typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY)
    return {
      upstreamUrl: "https://api.openai.com/v1/responses",
      authorization: `Bearer ${auth.OPENAI_API_KEY}`,
    };
  const tokens = auth.tokens as Record<string, unknown> | undefined;
  if (
    !tokens ||
    typeof tokens.access_token !== "string" ||
    typeof tokens.account_id !== "string"
  )
    throw new ModelAuthenticationError();
  return {
    upstreamUrl: "https://chatgpt.com/backend-api/codex/responses",
    authorization: `Bearer ${tokens.access_token}`,
    accountId: tokens.account_id,
  };
}
