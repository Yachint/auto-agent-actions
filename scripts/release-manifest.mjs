import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { reviewPolicyHash } from "../dist/src/queue/policy.js";

const [outputPath, appImage, analysisImage] = process.argv.slice(2);
if (process.argv.length !== 5 || !outputPath || !appImage || !analysisImage)
  throw new TypeError(
    "usage: npm run release:manifest -- <protected-output.json> <app image> <analysis image>",
  );
const execute = (command, args) =>
  execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  }).trim();
const inspect = (reference) => {
  const image = JSON.parse(
    execute("docker", ["image", "inspect", "--", reference]),
  )[0];
  if (typeof image.Id !== "string" || !/^sha256:[a-f0-9]{64}$/.test(image.Id))
    throw new TypeError("invalid image identity");
  return {
    reference,
    id: image.Id,
    repositoryDigests: image.RepoDigests ?? [],
    architecture: image.Architecture,
    os: image.Os,
  };
};
await writeFile(
  outputPath,
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      revision: execute("git", ["rev-parse", "HEAD"]),
      dirty: execute("git", ["status", "--porcelain"]).length > 0,
      lockfileSha256: createHash("sha256")
        .update(await readFile("package-lock.json"))
        .digest("hex"),
      codexCliVersion: process.env.CODEX_CLI_VERSION ?? "0.155.1",
      policyHash: reviewPolicyHash(),
      appImage: inspect(appImage),
      analysisImage: inspect(analysisImage),
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600, flag: "wx" },
);
console.log("Protected release manifest written");
