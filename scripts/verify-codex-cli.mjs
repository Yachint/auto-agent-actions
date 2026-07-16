import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const REQUIRED_EXEC_FLAGS = [
  "--strict-config",
  "--sandbox",
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--output-schema",
  "--output-last-message",
];

export function verifyCodexHelp(helpText) {
  const missing = REQUIRED_EXEC_FLAGS.filter((flag) => !helpText.includes(flag));
  if (missing.length > 0) {
    throw new Error(`Codex CLI is missing required exec flags: ${missing.join(", ")}`);
  }
}

function main() {
  const expectedVersion = process.argv[2];
  if (expectedVersion === undefined || expectedVersion.length === 0) {
    throw new TypeError("expected Codex CLI version is required");
  }
  const version = runCodex(["--version"]);
  if (!version.split(/\s+/).includes(expectedVersion)) {
    throw new Error("installed Codex CLI version does not match CODEX_CLI_VERSION");
  }
  verifyCodexHelp(runCodex(["exec", "--help"]));
  process.stdout.write(`PASS Codex CLI ${expectedVersion} supports the locked-down runner flags\n`);
}

function runCodex(args) {
  const result = spawnSync("codex", args, { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error(`codex ${args.join(" ")} failed`);
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`FAIL ${error instanceof Error ? error.message : "Codex verification failed"}\n`);
    process.exitCode = 1;
  }
}
