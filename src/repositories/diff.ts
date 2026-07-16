import { realpath } from "node:fs/promises";
import path from "node:path";

import {
  assertAbsolutePath,
  createGitExecutor,
  decodeGitText,
  type GitExecutor,
} from "./git.js";

const FULL_GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const HUNK_HEADER_PATTERN = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export interface DiffInspectorOptions {
  gitExecutor?: GitExecutor;
  maxChangedFiles?: number;
  maxPatchBytesPerFile?: number;
}

export interface DiffLineRange {
  start: number;
  end: number;
}

export type ChangedFileStatus = "A" | "M" | "D" | "R" | "C" | "T" | "U" | "X" | "B";

export interface ChangedFile {
  status: ChangedFileStatus;
  path: string;
  previousPath?: string;
  isDeleted: boolean;
  rightSideRanges: DiffLineRange[];
}

export interface ExactDiff {
  baseSha: string;
  headSha: string;
  files: ChangedFile[];
}

export class DiffLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiffLimitError";
  }
}

export class DiffInspector {
  readonly gitExecutor: GitExecutor;
  readonly maxChangedFiles: number;
  readonly maxPatchBytesPerFile: number;

  constructor(options: DiffInspectorOptions = {}) {
    this.gitExecutor = options.gitExecutor ?? createGitExecutor();
    this.maxChangedFiles = options.maxChangedFiles ?? 500;
    this.maxPatchBytesPerFile = options.maxPatchBytesPerFile ?? 5 * 1024 * 1024;

    if (!Number.isSafeInteger(this.maxChangedFiles) || this.maxChangedFiles < 1) {
      throw new TypeError("maxChangedFiles must be a positive integer");
    }
    if (
      !Number.isSafeInteger(this.maxPatchBytesPerFile) ||
      this.maxPatchBytesPerFile < 1
    ) {
      throw new TypeError("maxPatchBytesPerFile must be a positive integer");
    }
  }

  async inspect(input: {
    worktreePath: string;
    baseSha: string;
    headSha: string;
  }): Promise<ExactDiff> {
    assertAbsolutePath("worktreePath", input.worktreePath);
    validateFullSha("baseSha", input.baseSha);
    validateFullSha("headSha", input.headSha);
    const worktreePath = await realpath(input.worktreePath);
    const baseSha = input.baseSha.toLowerCase();
    const headSha = input.headSha.toLowerCase();

    const [resolvedBase, resolvedHead] = await Promise.all([
      this.resolveCommit(worktreePath, baseSha),
      this.resolveCommit(worktreePath, headSha),
    ]);
    if (resolvedBase !== baseSha || resolvedHead !== headSha) {
      throw new TypeError("diff SHAs must resolve to the exact requested commits");
    }

    const nameStatus = await this.gitExecutor({
      args: [
        "-C",
        worktreePath,
        "diff",
        "--name-status",
        "-z",
        "--find-renames",
        "--no-ext-diff",
        baseSha,
        headSha,
        "--",
      ],
      maxOutputBytes: this.maxPatchBytesPerFile,
    });
    const files = parseNameStatus(nameStatus.stdout);
    if (files.length > this.maxChangedFiles) {
      throw new DiffLimitError(
        `Diff contains ${files.length} files; limit is ${this.maxChangedFiles}`,
      );
    }

    const inspectedFiles: ChangedFile[] = [];
    for (const file of files) {
      if (file.isDeleted) {
        inspectedFiles.push({ ...file, rightSideRanges: [] });
        continue;
      }

      const patch = await this.gitExecutor({
        args: [
          "-C",
          worktreePath,
          "diff",
          "--unified=0",
          "--no-color",
          "--no-ext-diff",
          baseSha,
          headSha,
          "--",
          ...(file.previousPath === undefined ? [] : [file.previousPath]),
          file.path,
        ],
        maxOutputBytes: this.maxPatchBytesPerFile,
      });
      inspectedFiles.push({
        ...file,
        rightSideRanges: parseRightSideRanges(decodeGitText(patch)),
      });
    }

    return { baseSha, headSha, files: inspectedFiles };
  }

  private async resolveCommit(
    worktreePath: string,
    revision: string,
  ): Promise<string> {
    return decodeGitText(
      await this.gitExecutor({
        args: [
          "-C",
          worktreePath,
          "rev-parse",
          "--verify",
          `${revision}^{commit}`,
        ],
      }),
    )
      .trim()
      .toLowerCase();
  }
}

export function isRangeOnRightSide(
  diff: ExactDiff,
  filePath: string,
  startLine: number,
  endLine: number,
): boolean {
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    path.posix.normalize(filePath) !== filePath
  ) {
    return false;
  }

  const file = diff.files.find((candidate) => candidate.path === filePath);
  if (!file || file.isDeleted) return false;

  return file.rightSideRanges.some(
    (range) => startLine >= range.start && endLine <= range.end,
  );
}

function parseNameStatus(buffer: Buffer): Omit<ChangedFile, "rightSideRanges">[] {
  const fields = buffer.toString("utf8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  const files: Omit<ChangedFile, "rightSideRanges">[] = [];

  for (let index = 0; index < fields.length; ) {
    const statusField = fields[index++];
    if (!statusField || !/^[AMDRCTUXB](?:\d{1,3})?$/.test(statusField)) {
      throw new TypeError("Git returned an invalid name-status record");
    }

    const status = statusField[0] as ChangedFileStatus;
    if (status === "R" || status === "C") {
      const previousPath = fields[index++];
      const currentPath = fields[index++];
      if (!previousPath || !currentPath) {
        throw new TypeError("Git returned an incomplete rename/copy record");
      }
      files.push({
        status,
        path: currentPath,
        previousPath,
        isDeleted: false,
      });
      continue;
    }

    const currentPath = fields[index++];
    if (!currentPath) {
      throw new TypeError("Git returned an incomplete name-status record");
    }
    files.push({
      status,
      path: currentPath,
      isDeleted: status === "D",
    });
  }

  return files;
}

function parseRightSideRanges(patch: string): DiffLineRange[] {
  const ranges: DiffLineRange[] = [];

  for (const line of patch.split("\n")) {
    const match = HUNK_HEADER_PATTERN.exec(line);
    if (!match) continue;
    const start = Number.parseInt(match[1] ?? "", 10);
    const count = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || count < 0) {
      throw new TypeError("Git returned an invalid diff hunk range");
    }
    if (count === 0) continue;
    ranges.push({ start, end: start + count - 1 });
  }

  return ranges;
}

function validateFullSha(name: string, value: string): void {
  if (!FULL_GIT_SHA_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a full Git object ID`);
  }
}
