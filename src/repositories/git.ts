import { execFile } from "node:child_process";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export interface GitCommand {
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  authentication?: GitCommandAuthentication;
}

export interface GitCommandAuthentication {
  readonly askPassPath: string;
  readonly username: string;
  readonly password: string;
}

export interface GitCommandResult {
  stdout: Buffer;
  stderr: Buffer;
}

export type GitExecutor = (command: GitCommand) => Promise<GitCommandResult>;

export class GitCommandError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(exitCode: number | null, signal: NodeJS.Signals | null) {
    super("Git command failed");
    this.name = "GitCommandError";
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

export function createGitExecutor(
  gitBinary = "git",
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
): GitExecutor {
  const baseEnvironment = createGitEnvironment(sourceEnvironment);

  return async (command) =>
    new Promise((resolve, reject) => {
      const args = ["-c", "core.hooksPath=/dev/null", ...command.args];
      const environment = createAuthenticatedGitEnvironment(
        baseEnvironment,
        command.authentication,
      );

      execFile(
        gitBinary,
        args,
        {
          cwd: command.cwd,
          env: environment,
          encoding: "buffer",
          timeout: command.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: command.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
          killSignal: "SIGKILL",
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            const processError = error as NodeJS.ErrnoException & {
              code?: string | number;
              signal?: NodeJS.Signals;
            };
            const exitCode =
              typeof processError.code === "number" ? processError.code : null;
            reject(new GitCommandError(exitCode, processError.signal ?? null));
            return;
          }

          resolve({ stdout, stderr });
        },
      );
    });
}

function createAuthenticatedGitEnvironment(
  base: NodeJS.ProcessEnv,
  authentication: GitCommandAuthentication | undefined,
): NodeJS.ProcessEnv {
  if (authentication === undefined) return base;
  assertAbsolutePath("askPassPath", authentication.askPassPath);
  for (const [name, value] of [
    ["username", authentication.username],
    ["password", authentication.password],
  ] as const) {
    if (value.length === 0 || value.includes("\0") || /[\r\n]/.test(value)) {
      throw new TypeError(`${name} must be a non-empty single-line credential`);
    }
  }
  return {
    ...base,
    GIT_ASKPASS: authentication.askPassPath,
    GIT_ASKPASS_REQUIRE: "force",
    AUTO_AGENT_GIT_USERNAME: authentication.username,
    AUTO_AGENT_GIT_PASSWORD: authentication.password,
    LC_ALL: "C",
  };
}

export function createGitEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const allowedNames = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SYSTEMROOT",
    "COMSPEC",
    "PATHEXT",
  ];
  const environment: NodeJS.ProcessEnv = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };

  for (const name of allowedNames) {
    if (source[name] !== undefined) {
      environment[name] = source[name];
    }
  }

  return environment;
}

export function decodeGitText(result: GitCommandResult): string {
  return result.stdout.toString("utf8");
}

export function assertAbsolutePath(name: string, value: string): void {
  if (!path.isAbsolute(value) || value.includes("\0")) {
    throw new TypeError(`${name} must be an absolute path`);
  }
}
