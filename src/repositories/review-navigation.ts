import { createHash } from "node:crypto";
import path from "node:path";
import type { ChangedFile } from "./diff.js";
import { DiffLimitError } from "./diff.js";
import { decodeGitText, type GitExecutor } from "./git.js";

export const MAX_REVIEW_BRIEF_BYTES = 6 * 1024;
export const encodeReviewData = (data: unknown): string => JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
export interface FileReviewContext {
  path: string;
  sourceDigest: string | null;
  references: string[];
  navigation: { line: number; text: string }[];
  navigationTruncated: boolean;
}

/** Navigation data only: parses frozen text without executing target code. */
export async function loadReviewContexts(options: {
  git: GitExecutor; worktreePath: string; headSha: string;
  files: readonly ChangedFile[]; signal?: AbortSignal;
}): Promise<Map<string, FileReviewContext>> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(options.headSha))
    throw new TypeError("review navigation requires frozen object IDs");
  if (options.files.some(file => !file.path || /^[\/\\]|^[A-Za-z]:/.test(file.path) || /[\0\r\n\\]/.test(file.path) ||
      file.path.split("/").some(part => !part || part === "." || part === "..")))
    throw new TypeError("review navigation requires normalized repository paths");
  const contexts = new Map<string, FileReviewContext>();
  const inventory = new Set(options.files.map(file => file.path));
  let bytes = 0;
  for (const file of options.files) {
    options.signal?.throwIfAborted();
    let source = "";
    const readable = !file.isDeleted && /\.(?:[cm]?[jt]sx?|py|rs|go|md|ya?ml|json)$/i.test(file.path);
    if (readable) {
      source = decodeGitText(await options.git({
        args: ["-C", options.worktreePath, "show", "--no-ext-diff", "--no-textconv", `${options.headSha}:${file.path}`],
        maxOutputBytes: 5 * 1024 * 1024,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }));
      bytes += Buffer.byteLength(source);
      if (bytes > 32 * 1024 * 1024) throw new DiffLimitError("review navigation exceeds bounded source capacity");
    }
    const declarations: { line: number; text: string }[] = [];
    const imports: { line: number; text: string }[] = [];
    if (!source.includes("\0")) for (const [index, line] of source.split("\n").entries()) {
      const entry = { line: index + 1, text: line.trim().slice(0, 160) };
      if (/^\s*(?:import\b|export\b.*\bfrom\b|.*\brequire\s*\()/.test(line)) imports.push(entry);
      else if (isDeclarationBoundary(line) || /^#{1,6}\s/.test(line)) declarations.push(entry);
    }
    const navigation = [...imports.slice(0, 8), ...declarations.slice(0, 24)].sort((a, b) => a.line - b.line);
    contexts.set(file.path, { path: file.path,
      sourceDigest: readable ? createHash("sha256").update(source).digest("hex") : null,
      references: source.includes("\0") ? [] : relativeReferences(file.path, source, inventory), navigation,
      navigationTruncated: imports.length > 8 || declarations.length > 24,
    });
  }
  return contexts;
}

export function relativeReferences(name: string, text: string, inventory: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["'](\.[^"'\r\n]+)["']/g)) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1]!));
    for (const candidate of [resolved, ...[".ts", ".tsx", ".js", ".jsx"].map(ext => resolved.replace(/\.[cm]?jsx?$/, "") + ext), ...["ts", "tsx", "js"].map(ext => `${resolved}/index.${ext}`)])
      if (inventory.has(candidate)) found.add(candidate);
  }
  return [...found].sort();
}

/** A heuristic cut point; never a claim that repository syntax is valid. */
export function isDeclarationBoundary(line: string): boolean {
  return /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|class|interface|type|enum|namespace|def|struct|fn|func)\b/.test(line) ||
    /^\s*(?:export\s+)?(?:const|let|var)\s+[\w$]+.*(?:=>|\bfunction\b)/.test(line) ||
    /^\s*(?:describe|it|test)(?:\.\w+)*\s*\(/.test(line);
}

export function buildChunkBrief(files: readonly ChangedFile[], contexts: ReadonlyMap<string, FileReviewContext>,
  dependencies: ReadonlyMap<string, ReadonlySet<string>>): { chunkId: string; brief: string; boundaryPaths: string[]; boundaryPathsTruncated: boolean } {
  const names = files.map(file => file.path);
  const outside = [...new Set(names.flatMap(name => [...dependencies.get(name) ?? []]))].filter(name => !names.includes(name)).sort();
  const chunkId = createHash("sha256").update(JSON.stringify(names)).digest("hex");
  let lines = 16, width = 120, boundaries = 8;
  for (;;) {
    const boundaryPaths = outside.slice(0, boundaries);
    const brief = encodeReviewData({ chunkId, supportOnly: true, heuristic: true,
      boundaryPaths, boundaryPathsTruncated: outside.length > boundaries,
      members: files.map(file => {
        const context = contexts.get(file.path);
        if (!context) throw new TypeError("missing frozen review context");
        return { path: file.path, status: file.status, sourceDigest: context.sourceDigest,
          navigation: context.navigation.slice(0, lines).map(entry => ({ line: entry.line, text: entry.text.slice(0, width) })),
          navigationTruncated: context.navigationTruncated || context.navigation.length > lines || context.navigation.some(entry => entry.text.length > width),
          referencesWithinChunk: context.references.filter(name => names.includes(name)),
        };
      }),
    });
    if (Buffer.byteLength(brief) <= MAX_REVIEW_BRIEF_BYTES) return { chunkId, brief, boundaryPaths, boundaryPathsTruncated: outside.length > boundaries };
    if (lines > 0) { lines = Math.floor(lines / 2); width = Math.floor(width / 2); }
    else if (boundaries > 0) boundaries = Math.floor(boundaries / 2);
    else throw new DiffLimitError("review chunk inventory exceeds bounded brief capacity");
  }
}
