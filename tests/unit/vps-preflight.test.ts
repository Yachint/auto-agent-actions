import { describe, expect, it } from "vitest";

import {
  parseEnvironmentFile,
  validatePreflightEnvironment,
} from "../../scripts/vps-preflight.mjs";

const valid = {
  WEBHOOK_DOMAIN: "reviews.example.com",
  ACME_EMAIL: "owner@example.com",
  GITHUB_APP_ID: "123456",
  GITHUB_ALLOWED_REPOSITORIES: "owner/project,owner/private-project",
  CODEX_CLI_VERSION: "1.2.3",
  GITHUB_APP_PRIVATE_KEY_HOST_FILE: "/opt/app/secrets/app.pem",
  GITHUB_WEBHOOK_SECRET_HOST_FILE: "/opt/app/secrets/webhook",
  READ_TOKEN_BROKER_SECRET_HOST_FILE: "/opt/app/secrets/broker",
  CODEX_CREDENTIALS_DIR: "/opt/app/codex-home",
};

describe("VPS preflight configuration", () => {
  it("parses comments and quoted values without interpolation", () => {
    expect(parseEnvironmentFile("# comment\nNAME='literal value'\nOTHER=value\n")).toEqual({
      NAME: "literal value",
      OTHER: "value",
    });
  });

  it("accepts the required non-secret deployment shape", () => {
    expect(validatePreflightEnvironment(valid)).toBe(valid);
  });

  it.each([
    [{ ...valid, GITHUB_APP_ID: "0" }, /GITHUB_APP_ID/],
    [{ ...valid, CODEX_CLI_VERSION: "0.0.0-replace-me" }, /CODEX_CLI_VERSION/],
    [{ ...valid, GITHUB_ALLOWED_REPOSITORIES: "owner/project,owner/project" }, /unique/],
    [{ ...valid, CODEX_CREDENTIALS_DIR: "relative/path" }, /absolute/],
  ])("rejects unsafe or placeholder deployment values", (environment, message) => {
    expect(() => validatePreflightEnvironment(environment)).toThrow(message);
  });
});
