import { describe, expect, it } from "vitest";

import {
  parseReviewOutput,
  ReviewOutputValidationError,
  validateReviewOutput,
} from "../../src/validation/review-output.js";

const validOutput = {
  findings: [
    {
      title: "Handle the failed request",
      body: "The rejected promise currently terminates the worker.",
      priority: 1,
      confidence: 0.94,
      path: "src/worker.ts",
      start_line: 42,
      end_line: 44,
    },
  ],
  summary: "One actionable finding.",
};

describe("review output validation", () => {
  it("accepts output that matches the schema", () => {
    expect(parseReviewOutput(JSON.stringify(validOutput))).toEqual(validOutput);
  });

  it("rejects malformed JSON", () => {
    expect(() => parseReviewOutput("{not-json")).toThrow(
      ReviewOutputValidationError,
    );
  });

  it("rejects additional properties", () => {
    expect(() =>
      validateReviewOutput({ ...validOutput, unexpected: true }),
    ).toThrow(/additional properties/);
  });

  it.each([-1, 4, 1.5])("rejects priority %s", (priority) => {
    expect(() =>
      validateReviewOutput({
        ...validOutput,
        findings: [{ ...validOutput.findings[0], priority }],
      }),
    ).toThrow(ReviewOutputValidationError);
  });

  it.each([-0.01, 1.01])("rejects confidence %s", (confidence) => {
    expect(() =>
      validateReviewOutput({
        ...validOutput,
        findings: [{ ...validOutput.findings[0], confidence }],
      }),
    ).toThrow(ReviewOutputValidationError);
  });

  it.each(["/etc/passwd", "../secret", "src/../secret", "C:/secret"])(
    "rejects unsafe repository path %s",
    (unsafePath) => {
      expect(() =>
        validateReviewOutput({
          ...validOutput,
          findings: [{ ...validOutput.findings[0], path: unsafePath }],
        }),
      ).toThrow(/repository-relative path/);
    },
  );

  it("rejects an inverted line range", () => {
    expect(() =>
      validateReviewOutput({
        ...validOutput,
        findings: [
          { ...validOutput.findings[0], start_line: 44, end_line: 42 },
        ],
      }),
    ).toThrow(/greater than or equal to start_line/);
  });
});
