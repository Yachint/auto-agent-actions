import type { ChangedFile, DiffLineRange } from "../repositories/diff.js";

/** GitHub's patches include context; only '+' lines are publishable RIGHT anchors. */
export function githubPatchRanges(patch: string): DiffLineRange[] {
  if (Buffer.byteLength(patch) > 5 * 1024 * 1024)
    throw new TypeError("GitHub patch exceeds limit");
  const ranges: DiffLineRange[] = [];
  let lineNumber: number | undefined;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      lineNumber = Number(hunk[1]);
      continue;
    }
    if (lineNumber === undefined || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      if (!Number.isSafeInteger(lineNumber) || lineNumber < 1)
        throw new TypeError("invalid GitHub patch range");
      const previous = ranges.at(-1);
      if (previous?.end === lineNumber - 1) previous.end = lineNumber;
      else ranges.push({ start: lineNumber, end: lineNumber });
      lineNumber++;
    } else if (line.startsWith(" ")) lineNumber++;
    else if (!line.startsWith("-")) lineNumber = undefined;
  }
  return ranges;
}

export function githubChangedFile(value: unknown): ChangedFile {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("invalid GitHub changed file");
  const file = value as Record<string, unknown>;
  const statuses: Record<string, ChangedFile["status"]> = {
    added: "A",
    removed: "D",
    modified: "M",
    renamed: "R",
    copied: "C",
    changed: "T",
    unchanged: "M",
  };
  if (
    typeof file.filename !== "string" ||
    typeof file.status !== "string" ||
    statuses[file.status] === undefined
  )
    throw new TypeError("invalid GitHub changed file metadata");
  return {
    path: file.filename,
    status: statuses[file.status]!,
    isDeleted: file.status === "removed",
    ...(typeof file.previous_filename === "string"
      ? { previousPath: file.previous_filename }
      : {}),
    rightSideRanges:
      file.status === "removed" || typeof file.patch !== "string"
        ? []
        : githubPatchRanges(file.patch),
  };
}
