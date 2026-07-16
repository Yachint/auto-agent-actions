import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  FixtureValidationError,
  parsePullRequestFixture,
  ReviewNotEligibleError,
} from "../../src/github/pull-request-fixture.js";

const fixtureUrl = new URL("../fixtures/pull_request.opened.json", import.meta.url);

describe("pull request fixture", () => {
  it("extracts the immutable review fields", async () => {
    const fixture: unknown = JSON.parse(await readFile(fixtureUrl, "utf8"));

    expect(parsePullRequestFixture(fixture)).toEqual({
      action: "opened",
      repository: "example/project",
      remoteUrl: "https://github.com/example/project.git",
      pullRequestNumber: 7,
      baseBranch: "main",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    });
  });

  it.each(["closed", "edited", "converted_to_draft"])(
    "rejects unsupported action %s",
    async (action) => {
      const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as Record<
        string,
        unknown
      >;
      fixture.action = action;
      expect(() => parsePullRequestFixture(fixture)).toThrow(
        ReviewNotEligibleError,
      );
    },
  );

  it("rejects draft pull requests", async () => {
    const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as {
      pull_request: Record<string, unknown>;
    };
    fixture.pull_request.draft = true;
    expect(() => parsePullRequestFixture(fixture)).toThrow(/draft/);
  });

  it("rejects forked pull requests", async () => {
    const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as {
      pull_request: { head: { repo: Record<string, unknown> } };
    };
    fixture.pull_request.head.repo.full_name = "external-contributor/project";
    expect(() => parsePullRequestFixture(fixture)).toThrow(/forked pull requests/);
  });

  it("rejects abbreviated SHAs", async () => {
    const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as {
      pull_request: { head: Record<string, unknown> };
    };
    fixture.pull_request.head.sha = "abc123";
    expect(() => parsePullRequestFixture(fixture)).toThrow(
      FixtureValidationError,
    );
  });
});
