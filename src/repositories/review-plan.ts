import { createHash } from "node:crypto";
import path from "node:path";
import type { ChangedFile, DiffLineRange } from "./diff.js";
import { DiffLimitError } from "./diff.js";
import { decodeGitText, type GitExecutor } from "./git.js";

export const MAX_REVIEW_UNIT_BYTES = 24 * 1024;
const MAX_PLAN_BYTES = 32 * 1024 * 1024;
const MAX_UNITS = 256;
export const encodeReviewData = (data: unknown): string => JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

interface PatchLine { offset: number; end: number; headLine: number | null; oldLine: number | null; kind: string; hunk: string | null }
export interface ReviewPatchSlice {
  path: string;
  patch: string;
  patchDigest: string;
  startOffset: number;
  endOffset: number;
  totalCharacters: number;
  firstPatchLine: number;
  firstColumn: number;
  firstLineKind: string;
  startingHeadLine: number | null;
  startingOldLine: number | null;
  precedingHunk: string | null;
  rightSideRanges: DiffLineRange[];
}
export interface ReviewUnit {
  id: string;
  files: ChangedFile[];
  slices: ReviewPatchSlice[];
  context: string;
}

/** Complete frozen patches, split by encoded content, with static relative-import affinity. */
export async function buildReviewPlan(options: {
  git: GitExecutor; worktreePath: string; comparisonSha: string; headSha: string;
  files: readonly ChangedFile[]; maxFiles: number; signal?: AbortSignal;
  maxUnitBytes?: number;
}): Promise<ReviewUnit[]> {
  const limit = options.maxUnitBytes ?? MAX_REVIEW_UNIT_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 2048 || limit > MAX_REVIEW_UNIT_BYTES ||
      !Number.isSafeInteger(options.maxFiles) || options.maxFiles < 1 || options.maxFiles > 32)
    throw new TypeError("invalid review planning limits");
  if (![options.comparisonSha, options.headSha].every(sha => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)))
    throw new TypeError("review plan requires frozen object IDs");
  const inventory = new Map(options.files.map(file => [file.path, file]));
  if (inventory.size !== options.files.length) throw new TypeError("duplicate review paths");
  const pending: ReviewPatchSlice[] = [];
  const dependencies = new Map<string, Set<string>>();
  let totalBytes = 0;
  for (const file of options.files) {
    options.signal?.throwIfAborted();
    const names = [...new Set([file.path, ...(file.previousPath === undefined ? [] : [file.previousPath])])];
    if (names.some(name => !name || /^[\/\\]|^[A-Za-z]:/.test(name) || /[\0\r\n\\]/.test(name) ||
        name.split("/").some(part => !part || part === "." || part === "..")))
      throw new TypeError("review plan requires normalized repository paths");
    let patch = decodeGitText(await options.git({
      args: ["-C", options.worktreePath, "diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--unified=3", "--color=never", options.comparisonSha, options.headSha, "--", ...names.map(name => `:(literal)${name}`)],
      maxOutputBytes: 5 * 1024 * 1024,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }));
    if ((patch.match(/^diff --git /gm) ?? []).length > 1) {
      // A rename's old pathname can also have been recreated. Compare exact blobs
      // instead of accidentally assigning another file's patch to this path.
      const oldBlob = decodeGitText(await options.git({ args: ["-C", options.worktreePath, "rev-parse", "--verify", `${options.comparisonSha}:${file.previousPath ?? file.path}`], maxOutputBytes: 1024, ...(options.signal === undefined ? {} : { signal: options.signal }) })).trim();
      const newBlob = decodeGitText(await options.git({ args: ["-C", options.worktreePath, "rev-parse", "--verify", `${options.headSha}:${file.path}`], maxOutputBytes: 1024, ...(options.signal === undefined ? {} : { signal: options.signal }) })).trim();
      if (![oldBlob, newBlob].every(sha => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha))) throw new TypeError("invalid frozen blob IDs");
      patch = decodeGitText(await options.git({ args: ["-C", options.worktreePath, "diff", "--no-ext-diff", "--no-textconv", "--unified=3", "--color=never", oldBlob, newBlob], maxOutputBytes: 5 * 1024 * 1024, ...(options.signal === undefined ? {} : { signal: options.signal }) }));
    }
    totalBytes += Buffer.byteLength(patch);
    if (totalBytes > MAX_PLAN_BYTES) throw new DiffLimitError("review plan exceeds bounded patch capacity");
    pending.push(...splitReviewPatch(file, patch, limit));
    if (pending.length > MAX_UNITS * options.maxFiles) throw new DiffLimitError("review plan exceeds bounded unit capacity");
    const imports = new Set<string>();
    // This only recognizes static references in patch data. It never evaluates repository code.
    for (const match of patch.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["'](\.[^"'\r\n]+)["']/g)) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), match[1]!));
      for (const candidate of [resolved, ...[".ts", ".tsx", ".js", ".jsx"].map(ext => resolved.replace(/\.[cm]?jsx?$/, "") + ext), ...["ts", "tsx", "js"].map(ext => `${resolved}/index.${ext}`)])
        if (inventory.has(candidate)) imports.add(candidate);
    }
    dependencies.set(file.path, imports);
  }
  const importEdges = [...dependencies].flatMap(([from, targets]) => [...targets].map(target => [from, target] as const));
  for (const [from, target] of importEdges) dependencies.get(target)?.add(from);
  const units: ReviewUnit[] = [];
  while (pending.length > 0) {
    options.signal?.throwIfAborted();
    const slices = [pending.shift()!];
    const names = new Set([slices[0]!.path]);
    for (;;) {
      const candidates = pending.map((slice, index) => ({ slice, index,
        affinity: Math.max(...[...names].map(name => affinity(name, slice.path, dependencies))) }))
        .sort((a, b) => b.affinity - a.affinity || a.index - b.index);
      const next = candidates.find(({ slice, affinity }) => affinity > 0 &&
        (names.has(slice.path) || names.size < options.maxFiles) &&
        Buffer.byteLength(encodeReviewData([...slices, slice])) <= limit);
      if (!next) break;
      slices.push(...pending.splice(next.index, 1)); names.add(next.slice.path);
    }
    const files = [...names].map(name => ({ ...inventory.get(name)!, rightSideRanges: mergeRanges(slices.filter(slice => slice.path === name).flatMap(slice => slice.rightSideRanges)) }));
    const context = encodeReviewData(slices);
    const id = createHash("sha256").update(context).digest("hex");
    units.push({ id, files, slices, context });
    if (units.length > MAX_UNITS) throw new DiffLimitError("review plan exceeds bounded unit capacity");
  }
  // A coverage ledger is established before any model call. No truncated patch is treated as complete.
  for (const file of options.files) {
    const slices = units.flatMap(unit => unit.slices).filter(slice => slice.path === file.path).sort((a, b) => a.startOffset - b.startOffset);
    let cursor = 0;
    for (const slice of slices) {
      if (slice.startOffset !== cursor || slice.endOffset < cursor) throw new Error("review plan has a patch coverage gap");
      cursor = slice.endOffset;
    }
    if (!slices.length || cursor !== slices[0]!.totalCharacters ||
        createHash("sha256").update(slices.map(slice => slice.patch).join("")).digest("hex") !== slices[0]!.patchDigest)
      throw new Error("review plan failed complete patch coverage");
  }
  return units;
}

export function splitReviewPatch(file: ChangedFile, patch: string, limit = MAX_REVIEW_UNIT_BYTES): ReviewPatchSlice[] {
  if (!Number.isSafeInteger(limit) || limit < 2048 || limit > MAX_REVIEW_UNIT_BYTES) throw new TypeError("invalid review unit capacity");
  const lines: PatchLine[] = [];
  let offset = 0, head: number | null = null, old: number | null = null, hunk: string | null = null;
  for (const text of patch.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (text.startsWith("diff --git ")) { head = null; old = null; hunk = null; }
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header) { old = Number(header[1]); head = Number(header[2]); hunk = text.trimEnd(); }
    lines.push({ offset, end: offset + text.length, headLine: head, oldLine: old, kind: header ? "hunk" : text[0] ?? "", hunk });
    if (!header && head !== null && old !== null) {
      if (text.startsWith("+")) head++;
      else if (text.startsWith("-")) old++;
      else if (text.startsWith(" ")) { head++; old++; }
    }
    offset += text.length;
  }
  const digest = createHash("sha256").update(patch).digest("hex");
  const entry = (start: number, end: number): ReviewPatchSlice => {
    const firstIndex = lines.findIndex(line => line.end > start);
    const first = lines[firstIndex];
    return { path: file.path, patch: patch.slice(start, end), patchDigest: digest, startOffset: start, endOffset: end,
      totalCharacters: patch.length, firstPatchLine: firstIndex < 0 ? 1 : firstIndex + 1,
      firstColumn: first ? start - first.offset : 0, firstLineKind: first?.kind ?? "",
      startingHeadLine: first?.headLine ?? null, startingOldLine: first?.oldLine ?? null, precedingHunk: first?.hunk ?? null,
      rightSideRanges: mergeRanges(lines.filter(line => line.offset < end && line.end > start && line.kind === "+" && line.headLine !== null && line.headLine > 0)
        .map(line => ({ start: line.headLine!, end: line.headLine! })).filter(range => file.rightSideRanges.some(allowed => range.start >= allowed.start && range.end <= allowed.end))) };
  };
  const slices: ReviewPatchSlice[] = [];
  let start = 0;
  do {
    let low = start, high = Math.min(patch.length, start + limit);
    while (low < high) {
      const end = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(encodeReviewData([entry(start, end)])) <= limit) low = end;
      else high = end - 1;
    }
    if (low === start && patch.length > 0) throw new DiffLimitError("review patch metadata exceeds unit capacity");
    if (low < patch.length) {
      const newline = patch.lastIndexOf("\n", low - 1);
      if (newline >= start) low = newline + 1;
      else if (low > start && /[\uD800-\uDBFF]/.test(patch[low - 1]!)) low--;
    }
    if (low === start && patch.length > 0) throw new DiffLimitError("review patch cannot fit a complete code point");
    slices.push(entry(start, low)); start = low;
  } while (start < patch.length);
  return slices;
}

function affinity(a: string, b: string, dependencies: Map<string, Set<string>>): number {
  if (a === b) return 4;
  if (dependencies.get(a)?.has(b)) return 3;
  const stem = (name: string) => path.posix.basename(name).replace(/\.(?:test|spec)(?=\.)/, "").replace(/\.[^.]+$/, "");
  if (stem(a) === stem(b)) return 2;
  return path.posix.dirname(a) === path.posix.dirname(b) ? 1 : 0;
}
function mergeRanges(ranges: DiffLineRange[]): DiffLineRange[] {
  const merged: DiffLineRange[] = [];
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}
