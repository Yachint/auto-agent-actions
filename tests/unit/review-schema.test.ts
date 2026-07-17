import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const schemaUrl = new URL("../../src/codex/review-schema.json", import.meta.url);
const schema = JSON.parse(readFileSync(schemaUrl, "utf8")) as unknown;

describe("Codex review output schema", () => {
  it("uses the strict object shape required by Structured Outputs", () => {
    assertStrictObjectSchemas(schema);
  });

  it("represents a conditionally absent blocked reason as required and nullable", () => {
    expect(isRecord(schema)).toBe(true);
    if (!isRecord(schema)) return;

    expect(schema.required).toEqual([
      "status",
      "findings",
      "summary",
      "blocked_reason",
    ]);
    expect(isRecord(schema.properties)).toBe(true);
    if (!isRecord(schema.properties)) return;

    expect(schema.properties.blocked_reason).toEqual(
      expect.objectContaining({ type: ["string", "null"] }),
    );
  });
});

function assertStrictObjectSchemas(value: unknown, location = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertStrictObjectSchemas(item, `${location}[${index}]`),
    );
    return;
  }
  if (!isRecord(value)) return;

  if (isRecord(value.properties)) {
    const propertyNames = Object.keys(value.properties).sort();
    expect(value.additionalProperties, `${location}.additionalProperties`).toBe(
      false,
    );
    expect(Array.isArray(value.required), `${location}.required`).toBe(true);
    if (Array.isArray(value.required)) {
      expect(
        value.required.every((entry) => typeof entry === "string"),
        `${location}.required entries`,
      ).toBe(true);
      expect([...value.required].sort(), `${location}.required`).toEqual(
        propertyNames,
      );
    }
  }

  for (const [key, child] of Object.entries(value)) {
    assertStrictObjectSchemas(child, `${location}.${key}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
