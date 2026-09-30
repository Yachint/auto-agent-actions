import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createModelProxy } from "../../src/codex/model-proxy.js";
const exec = promisify(execFile);

it("limits the model proxy to one model and endpoint without exposing upstream credentials", async () => {
  const fetchUpstream = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response("data: done\n", {
      headers: { "content-type": "text/event-stream" },
    }),
  );
  const proxy = await createModelProxy({
    model: "gpt-5.6-sol",
    upstreamUrl: "https://api.openai.com/v1/responses",
    authorization: "Bearer upstream-secret",
    timeoutMs: 10000,
    fetch: fetchUpstream,
  });
  try {
    expect(
      (await fetch(`${proxy.baseUrl}/responses`, { method: "POST" })).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${proxy.baseUrl}/files`, {
          method: "POST",
          headers: { Authorization: `Bearer ${proxy.token}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${proxy.baseUrl}/responses`, {
          method: "POST",
          headers: { Authorization: `Bearer ${proxy.token}` },
          body: JSON.stringify({ model: "wrong" }),
        })
      ).status,
    ).toBe(403);
    const result = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${proxy.token}` },
      body: JSON.stringify({ model: "gpt-5.6-sol" }),
    });
    expect(await result.text()).toBe("data: done\n");
    expect(fetchUpstream).toHaveBeenCalledTimes(1);
    expect(fetchUpstream.mock.calls[0]![1]?.headers).toMatchObject({
      Authorization: "Bearer upstream-secret",
    });
    expect(proxy.token).not.toContain("upstream-secret");
  } finally {
    await proxy.close();
  }
});

describe.skipIf(process.env.RUN_NATIVE_SANDBOX_TEST !== "1")(
  "native per-job isolation",
  () => {
    let root: string;
    let job: string;
    let binary: string;
    beforeAll(async () => {
      root = await mkdtemp(path.join(tmpdir(), "aaa-isolation-test-"));
      job = path.join(root, "job");
      binary = path.join(root, "sandbox");
      await mkdir(job);
      await exec("cc", [
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        "native/review-sandbox.c",
        "-o",
        binary,
      ]);
      await writeFile(path.join(root, "broker-secret"), "secret");
      await writeFile(path.join(job, "allowed"), "allowed");
    });
    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });
    it("denies sibling files, parent process environment, and Unix sockets", async () => {
      const script = `const fs = require('fs'); const net = require('net'); const dgram = require('dgram');
      const udp = dgram.createSocket('udp4'); udp.on('error',e=>{if(!['EACCES','EPERM'].includes(e.code)) process.exitCode=6; udp.close();}); udp.send('synthetic',9,'127.0.0.1',e=>{if(!e || !['EACCES','EPERM'].includes(e.code)) process.exitCode=6; try{udp.close();}catch{}});
      if (fs.readFileSync(${JSON.stringify(path.join(job, "allowed"))}, 'utf8') !== 'allowed') process.exit(2);
      for (const name of [${JSON.stringify(path.join(root, "broker-secret"))}, '/proc/${process.pid}/environ']) {
        try { fs.readFileSync(name); process.exit(3); } catch(e) { if(e.code !== 'EACCES' && e.code !== 'EPERM') throw e; }
      }
      try { fs.truncateSync(${JSON.stringify(path.join(root, "broker-secret"))}, 0); process.exit(5); } catch(e) { if(!['EACCES','EPERM'].includes(e.code)) throw e; }
      const socket = net.connect('/tmp/nonexistent-test.sock'); socket.on('error', e => { if(e.code !== 'EPERM') process.exitCode = 4; });`;
      const result = await exec(
        binary,
        [
          "--list",
          "/",
          "--read",
          "/usr",
          "--read",
          "/bin",
          "--read",
          "/lib",
          "--read",
          "/etc/ssl",
          "--read",
          process.execPath,
          "--write",
          "/dev/null",
          "--write",
          job,
          "--",
          process.execPath,
          "-e",
          script,
        ],
        { env: { PATH: "/usr/bin:/bin" } },
      );
      expect(result.stderr).toBe("");
    });
  },
);
