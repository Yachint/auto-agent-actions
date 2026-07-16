import { cp, mkdir } from "node:fs/promises";

await mkdir(new URL("../dist/src/codex/", import.meta.url), { recursive: true });
await cp(
  new URL("../src/codex/review-schema.json", import.meta.url),
  new URL("../dist/src/codex/review-schema.json", import.meta.url),
);
await cp(
  new URL("../src/codex/review-instructions.md", import.meta.url),
  new URL("../dist/src/codex/review-instructions.md", import.meta.url),
);
