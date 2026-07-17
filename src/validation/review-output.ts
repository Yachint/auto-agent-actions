import { readFileSync } from "node:fs";
import path from "node:path";

import { Ajv, type ErrorObject, type SchemaObject } from "ajv";

export interface ReviewFinding {
  title: string;
  body: string;
  priority: 0 | 1 | 2 | 3;
  confidence: number;
  path: string;
  start_line: number;
  end_line: number;
}

interface ReviewOutputBase {
  findings: ReviewFinding[];
  summary: string;
}

export interface CompletedReviewOutput extends ReviewOutputBase {
  status: "completed";
}

export interface BlockedReviewOutput extends ReviewOutputBase {
  status: "blocked";
  blocked_reason: string;
}

export type ReviewOutput = CompletedReviewOutput | BlockedReviewOutput;

export interface ValidationIssue {
  location: string;
  message: string;
}

export class ReviewOutputValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(`Invalid review output: ${issues.map(formatIssue).join("; ")}`);
    this.name = "ReviewOutputValidationError";
    this.issues = issues;
  }
}

const schemaUrl = new URL("../codex/review-schema.json", import.meta.url);
const schema = JSON.parse(readFileSync(schemaUrl, "utf8")) as SchemaObject;
const ajv = new Ajv({ allErrors: true, strict: true });
const validateSchema = ajv.compile<ReviewOutput>(schema);

export function parseReviewOutput(serializedOutput: string): ReviewOutput {
  let value: unknown;

  try {
    value = JSON.parse(serializedOutput);
  } catch {
    throw new ReviewOutputValidationError([
      { location: "/", message: "must be valid JSON" },
    ]);
  }

  return validateReviewOutput(value);
}

export function validateReviewOutput(value: unknown): ReviewOutput {
  if (!validateSchema(value)) {
    throw new ReviewOutputValidationError(
      (validateSchema.errors ?? []).map(toValidationIssue),
    );
  }

  const semanticIssues = value.findings.flatMap(validateFinding);
  if (value.summary.trim().length === 0) {
    semanticIssues.push({
      location: "/summary",
      message: "must contain non-whitespace text",
    });
  }
  if (value.status === "blocked") {
    const blockedReason = (value as { blocked_reason?: unknown }).blocked_reason;
    if (value.findings.length > 0) {
      semanticIssues.push({
        location: "/findings",
        message: "must be empty when review status is blocked",
      });
    }
    if (typeof blockedReason !== "string") {
      semanticIssues.push({
        location: "/blocked_reason",
        message: "is required when review status is blocked",
      });
    } else if (blockedReason.trim().length === 0) {
      semanticIssues.push({
        location: "/blocked_reason",
        message: "must contain non-whitespace text",
      });
    }
  } else if ("blocked_reason" in value) {
    semanticIssues.push({
      location: "/blocked_reason",
      message: "must be omitted when review status is completed",
    });
  }
  if (semanticIssues.length > 0) {
    throw new ReviewOutputValidationError(semanticIssues);
  }

  return value;
}

export function validateCompletedReviewOutput(value: unknown): CompletedReviewOutput {
  const output = validateReviewOutput(value);
  if (output.status !== "completed") {
    throw new ReviewOutputValidationError([
      { location: "/status", message: "must be completed before publication" },
    ]);
  }
  return output;
}

function validateFinding(
  finding: ReviewFinding,
  index: number,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const location = `/findings/${index}`;

  if (!isSafeRepositoryPath(finding.path)) {
    issues.push({
      location: `${location}/path`,
      message: "must be a normalized repository-relative path",
    });
  }

  if (finding.end_line < finding.start_line) {
    issues.push({
      location: `${location}/end_line`,
      message: "must be greater than or equal to start_line",
    });
  }

  return issues;
}

function isSafeRepositoryPath(candidate: string): boolean {
  return (
    candidate !== "." &&
    !candidate.includes("\\") &&
    !candidate.includes("\0") &&
    !path.posix.isAbsolute(candidate) &&
    !/^[a-zA-Z]:\//.test(candidate) &&
    path.posix.normalize(candidate) === candidate &&
    !candidate.split("/").includes("..")
  );
}

function toValidationIssue(error: ErrorObject): ValidationIssue {
  return {
    location: error.instancePath || "/",
    message: error.message ?? "is invalid",
  };
}

function formatIssue(issue: ValidationIssue): string {
  return `${issue.location} ${issue.message}`;
}
