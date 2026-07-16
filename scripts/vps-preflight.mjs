import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const REQUIRED_VALUES = [
  "WEBHOOK_DOMAIN",
  "GITHUB_APP_ID",
  "GITHUB_ALLOWED_REPOSITORIES",
  "CODEX_CLI_VERSION",
  "APP_UID",
  "APP_GID",
];
const REQUIRED_PATHS = [
  "GITHUB_APP_PRIVATE_KEY_HOST_FILE",
  "GITHUB_WEBHOOK_SECRET_HOST_FILE",
  "READ_TOKEN_BROKER_SECRET_HOST_FILE",
  "CODEX_CREDENTIALS_DIR",
];

export function parseEnvironmentFile(contents) {
  const environment = {};
  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match === null) throw new TypeError(`invalid environment syntax on line ${index + 1}`);
    const [, name, rawValue] = match;
    if (Object.hasOwn(environment, name)) throw new TypeError(`duplicate environment name ${name}`);
    let value = rawValue;
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value.includes("\0") || /\r|\n/.test(value)) {
      throw new TypeError(`invalid environment value for ${name}`);
    }
    environment[name] = value;
  }
  return Object.freeze(environment);
}

export function validatePreflightEnvironment(environment) {
  for (const name of [...REQUIRED_VALUES, ...REQUIRED_PATHS]) {
    if (typeof environment[name] !== "string" || environment[name].length === 0) {
      throw new TypeError(`${name} is required`);
    }
  }
  if (!/^\d+$/.test(environment.GITHUB_APP_ID) || environment.GITHUB_APP_ID === "0") {
    throw new TypeError("GITHUB_APP_ID must be the created App's positive integer ID");
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(environment.WEBHOOK_DOMAIN) ||
    environment.WEBHOOK_DOMAIN.endsWith(".example.com")
  ) {
    throw new TypeError("WEBHOOK_DOMAIN is invalid");
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(environment.CODEX_CLI_VERSION) ||
    environment.CODEX_CLI_VERSION.includes("replace-me")
  ) {
    throw new TypeError("CODEX_CLI_VERSION must be an exact installed version");
  }
  for (const name of ["APP_UID", "APP_GID"]) {
    if (!/^[1-9]\d{0,9}$/.test(environment[name])) {
      throw new TypeError(`${name} must be a positive numeric ID`);
    }
    const numericId = Number(environment[name]);
    if (!Number.isSafeInteger(numericId) || numericId > 2_147_483_647) {
      throw new TypeError(`${name} is outside the supported numeric ID range`);
    }
  }
  const repositories = environment.GITHUB_ALLOWED_REPOSITORIES.split(",").map((value) => value.trim());
  if (
    repositories.some(
      (repository) =>
        !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(repository),
    ) ||
    new Set(repositories).size !== repositories.length
  ) {
    throw new TypeError("GITHUB_ALLOWED_REPOSITORIES must be a unique owner/name list");
  }
  for (const name of REQUIRED_PATHS) {
    if (!path.isAbsolute(environment[name]) || environment[name].includes("\0")) {
      throw new TypeError(`${name} must be an absolute path`);
    }
  }
  return environment;
}

async function inspectProtectedPath(filePath, kind, minimumBytes = 1) {
  const metadata = await lstat(filePath);
  if (kind === "file" && !metadata.isFile()) throw new TypeError(`${path.basename(filePath)} is not a file`);
  if (kind === "directory" && !metadata.isDirectory()) {
    throw new TypeError(`${path.basename(filePath)} is not a directory`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new TypeError(`${path.basename(filePath)} grants group or other permissions`);
  }
  if (kind === "file" && metadata.size < minimumBytes) {
    throw new TypeError(`${path.basename(filePath)} is unexpectedly small`);
  }
  return metadata;
}

async function main() {
  const environmentFile = path.resolve(process.argv[2] ?? ".env.vps");
  const environment = validatePreflightEnvironment(
    parseEnvironmentFile(await readFile(environmentFile, "utf8")),
  );
  pass("deployment environment is structurally valid");

  const expectedUid = Number(environment.APP_UID);
  const expectedGid = Number(environment.APP_GID);
  const protectedFiles = [
    await inspectProtectedPath(environment.GITHUB_APP_PRIVATE_KEY_HOST_FILE, "file", 100),
    await inspectProtectedPath(environment.GITHUB_WEBHOOK_SECRET_HOST_FILE, "file", 32),
    await inspectProtectedPath(environment.READ_TOKEN_BROKER_SECRET_HOST_FILE, "file", 32),
  ];
  for (const metadata of protectedFiles) {
    if (metadata.uid !== expectedUid || metadata.gid !== expectedGid) {
      throw new TypeError("secret file ownership must match APP_UID and APP_GID");
    }
  }
  const codexDirectory = await inspectProtectedPath(environment.CODEX_CREDENTIALS_DIR, "directory");
  if (codexDirectory.uid !== expectedUid || codexDirectory.gid !== expectedGid) {
    throw new TypeError("Codex credential directory ownership must match APP_UID and APP_GID");
  }
  const codexAuth = await inspectProtectedPath(
    path.join(environment.CODEX_CREDENTIALS_DIR, "auth.json"),
    "file",
    20,
  );
  if (codexAuth.uid !== expectedUid || codexAuth.gid !== expectedGid) {
    throw new TypeError("Codex auth.json ownership must match APP_UID and APP_GID");
  }
  pass("secret paths and Codex credential metadata are protected");

  checkCommand("docker", ["--version"]);
  checkCommand("docker", ["compose", "version"]);
  checkCommand("git", ["--version"]);
  checkCommand("codex", ["--version"]);
  pass("required host commands are available");

  const compose = spawnSync(
    "docker",
    ["compose", "--env-file", environmentFile, "config", "--quiet"],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  if (compose.status !== 0) throw new Error("docker compose configuration validation failed");
  pass("Docker Compose configuration is valid");
}

function checkCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} is unavailable`);
}

function pass(message) {
  process.stdout.write(`PASS ${message}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "unknown preflight failure";
    process.stderr.write(`FAIL ${message}\n`);
    process.exitCode = 1;
  });
}
