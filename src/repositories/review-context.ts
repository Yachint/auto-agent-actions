import type { ChangedFile } from "./diff.js";
import { decodeGitText, type GitExecutor } from "./git.js";

const MAX_CONTEXT_BYTES = 64 * 1024;
const encode = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

/** Frozen patches are untrusted data. Never execute diff drivers or repository programs. */
export async function buildGroupReviewContext(options: {
  git: GitExecutor;
  worktreePath: string;
  comparisonSha: string;
  headSha: string;
  files: readonly ChangedFile[];
  signal?: AbortSignal;
}): Promise<string> {
  if (![options.comparisonSha, options.headSha].every((sha) => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(sha)))
    throw new TypeError("review context requires frozen object IDs");
  const entries: { path: string; patch: string; patchComplete: boolean; providedPatchLines: number }[] = [];
  for (const file of options.files) {
    options.signal?.throwIfAborted();
    const paths = [...new Set([file.path, ...(file.previousPath === undefined ? [] : [file.previousPath])])];
    if (paths.some((value) => !value || /^[\/\\]|^[A-Za-z]:/.test(value) || /[\0\r\n\\]/.test(value) || value.split("/").some((part) => !part || part === "." || part === "..")))
      throw new TypeError("review context requires normalized repository paths");
    let patch: string;
    try {
      const result = await options.git({
        args: ["-C", options.worktreePath, "diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--unified=12", "--color=never", options.comparisonSha, options.headSha, "--", ...paths.map((value) => `:(literal)${value}`)],
        maxOutputBytes: 256 * 1024,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      patch = decodeGitText(result);
    } catch {
      options.signal?.throwIfAborted();
      // Optional prefill failed/oversized. The reviewer must inspect this path with its tools.
      continue;
    }
    const lines = patch.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    let low = 0, high = lines.length;
    while (low < high) {
      const count = Math.ceil((low + high) / 2);
      const entry = { path: file.path, patch: lines.slice(0, count).join(""), patchComplete: count === lines.length, providedPatchLines: count };
      if (Buffer.byteLength(encode([...entries, entry])) <= MAX_CONTEXT_BYTES) low = count;
      else high = count - 1;
    }
    const entry = { path: file.path, patch: lines.slice(0, low).join(""), patchComplete: low === lines.length, providedPatchLines: low };
    if ((low > 0 || lines.length === 0) && Buffer.byteLength(encode([...entries, entry])) <= MAX_CONTEXT_BYTES) entries.push(entry);
  }
  return encode(entries);
}
