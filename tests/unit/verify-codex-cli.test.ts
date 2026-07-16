import { describe, expect, it } from "vitest";

import { verifyCodexHelp } from "../../scripts/verify-codex-cli.mjs";

describe("containerized Codex CLI compatibility", () => {
  it("accepts help containing every locked-down runner flag", () => {
    expect(() =>
      verifyCodexHelp(
        "--strict-config --sandbox --ephemeral --ignore-user-config --ignore-rules --output-schema --output-last-message",
      ),
    ).not.toThrow();
  });

  it("rejects a CLI missing a required isolation flag", () => {
    expect(() => verifyCodexHelp("--sandbox --output-schema")).toThrow(/missing required/);
  });
});
