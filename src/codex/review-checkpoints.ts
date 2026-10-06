import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { validateCompletedReviewOutput, type CompletedReviewOutput } from "../validation/review-output.js";

const MAX_BYTES = 1024 * 1024;

export interface ReviewCheckpointStore {
  read(key: string, paths: readonly string[]): Promise<CompletedReviewOutput | undefined>;
  write(key: string, paths: readonly string[], output: CompletedReviewOutput): Promise<void>;
}

export interface CheckpointIO {
  read(file: string): Promise<string | undefined>;
  write(file: string, text: string): Promise<void>;
}

/** Parent-owned validated outputs only; raw prompts and patches are never cached. */
export class DiskReviewCheckpointStore implements ReviewCheckpointStore {
  constructor(readonly directory: string, readonly io: CheckpointIO = protectedIO) {}

  async read(key: string, paths: readonly string[]): Promise<CompletedReviewOutput | undefined> {
    const text = await this.io.read(this.#file(key));
    if (text === undefined) return;
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("review checkpoint exceeds size limit");
    let record: Record<string, unknown>;
    try { record = JSON.parse(text) as Record<string, unknown>; }
    catch { throw new Error("review checkpoint is malformed"); }
    if (!record || typeof record !== "object" || Array.isArray(record) ||
      Object.keys(record).sort().join(",") !== "key,output,paths" ||
      record.key !== key || JSON.stringify(record.paths) !== JSON.stringify(paths))
      throw new Error("review checkpoint does not match its inspection scope");
    const output = validateCompletedReviewOutput(record.output);
    assertGroupFindings(output, paths);
    return output;
  }

  async write(key: string, paths: readonly string[], output: CompletedReviewOutput): Promise<void> {
    const validated = validateCompletedReviewOutput(output);
    assertGroupFindings(validated, paths);
    const text = JSON.stringify({ key, paths, output: validated });
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("review checkpoint exceeds size limit");
    await this.io.write(this.#file(key), text);
  }

  #file(key: string): string {
    if (!/^[0-9a-f]{64}$/.test(key)) throw new TypeError("invalid review checkpoint identity");
    return path.join(this.directory, `${key}.json`);
  }
}

export function assertGroupFindings(output: CompletedReviewOutput, paths: readonly string[]): void {
  const allowed = new Set(paths);
  if (output.findings.some((finding) => !allowed.has(finding.path)))
    throw new Error("review group returned findings outside its requested paths");
}

const protectedIO: CheckpointIO = {
  async read(file) {
    let handle;
    try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_BYTES || (info.mode & 0o077) !== 0)
        throw new Error("review checkpoint is not a protected bounded file");
      return await handle.readFile("utf8");
    } finally { await handle.close(); }
  },
  async write(file, text) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    let closed = false;
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
      await handle.close();
      closed = true;
      await rename(temporary, file);
    } finally {
      try { if (!closed) await handle.close(); }
      finally { await rm(temporary, { force: true }); }
    }
  },
};
