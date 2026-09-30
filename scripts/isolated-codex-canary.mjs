import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { runIsolatedReview } from "../dist/src/codex/isolated-runner.js";
const root = await mkdtemp("/var/lib/auto-agent-actions/canary-");
const repository = `${root}/source`;
await mkdir(repository);
await mkdir(`${root}/outputs`);
const git = (...args) =>
  execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  }).trim();
git("init", "--initial-branch=main");
git("config", "user.name", "Test");
git("config", "user.email", "test@example.invalid");
await writeFile(`${repository}/file.txt`, "base\n");
git("add", ".");
git("commit", "-m", "base");
const baseSha = git("rev-parse", "HEAD");
await writeFile(`${repository}/file.txt`, "changed\n");
git("add", ".");
git("commit", "-m", "head");
const headSha = git("rev-parse", "HEAD");
let requests = 0;
let toolVerified = false;
const text = JSON.stringify({
  status: "completed",
  blocked_reason: null,
  findings: [],
  coverage: [{ path: "file.txt", status: "inspected" }],
  summary: "Synthetic canary complete.",
});
const item = {
  id: "msg_canary",
  type: "message",
  status: "completed",
  role: "assistant",
  content: [{ type: "output_text", text, annotations: [] }],
};
const response = {
  id: "resp_canary",
  object: "response",
  created_at: 1790770000,
  status: "completed",
  model: "gpt-6.1-sol",
  output: [item],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
};
globalThis.fetch = async (_url, init) => {
  requests++;
  if (init.headers.Authorization !== "Bearer test-upstream-secret")
    throw new Error("incorrect upstream capability");
  const payload = JSON.parse(init.body.toString());
  if (payload.model !== "gpt-6.1-sol" || payload.reasoning?.effort !== "high")
    throw new Error("review model or reasoning effort did not match the default policy");
  if (requests === 1) {
    const call = {
      type: "function_call",
      id: "fc_canary",
      call_id: "call_canary",
      name: "exec_command",
      arguments: JSON.stringify({
        cmd: `git diff --no-ext-diff --no-textconv ${baseSha} ${headSha} -- file.txt && if /bin/sh -c ': > .canary-write'; then exit 3; else printf read-only-denial-verified; fi`,
        max_output_tokens: 1000,
      }),
    };
    const events = [
      {
        type: "response.created",
        response: { ...response, status: "in_progress", output: [] },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...call, arguments: "" },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: call.id,
        output_index: 0,
        delta: call.arguments,
      },
      {
        type: "response.function_call_arguments.done",
        item_id: call.id,
        output_index: 0,
        arguments: call.arguments,
      },
      { type: "response.output_item.done", output_index: 0, item: call },
      { type: "response.completed", response: { ...response, output: [call] } },
    ];
    return new Response(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  }
  toolVerified = payload.input.some(
    (input) =>
      input.type === "function_call_output" &&
      JSON.stringify(input.output).includes("+changed") &&
      JSON.stringify(input.output).includes("read-only-denial-verified") &&
      JSON.stringify(input.output).includes("Process exited with code 0"),
  );
  if (!toolVerified) throw new Error("isolated diff inspection failed");
  const events = [
    {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_text.done",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text,
    },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  return new Response(
    events
      .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
};
try {
  const review = await runIsolatedReview({
    worktreePath: repository,
    expectedPaths: ["file.txt"],
    schemaPath: "/app/dist/src/codex/review-coverage-schema.json",
    instructionsPath: "/app/dist/src/codex/review-instructions.md",
    outputPath: `${root}/outputs/result.json`,
    model: "gpt-6.1-sol",
    reasoningEffort: "high",
    prompt: "Review the one changed file and return the required JSON.",
    timeoutMs: 15000,
    baseSha,
    headSha,
    sandboxBinary: "/usr/local/bin/review-sandbox",
    environment: {
      PATH: process.env.PATH,
      CODEX_API_KEY: "test-upstream-secret",
    },
  });
  if (review.status !== "completed" || !toolVerified)
    throw new Error("canary did not complete");
  console.log(
    "PASS isolated Codex canary with fake upstream; requests=" + requests,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
