import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import path from "node:path";
import { executeProcess, CodexExecutionError } from "./runner.js";

export async function verifyIsolationPolicy(
  binary: string,
  dataDirectory: string,
): Promise<void> {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(path.join(dataDirectory, "isolation-preflight-"));
  const job = path.join(root, "job");
  try {
    await mkdir(job);
    await writeFile(path.join(root, "denied"), "synthetic secret");
    await writeFile(path.join(job, "allowed"), "allowed");
    const script = `const fs = require('fs'); const net = require('net'); const dgram = require('dgram');
      const udp = dgram.createSocket('udp4'); udp.on('error',e=>{if(!['EACCES','EPERM'].includes(e.code)) process.exitCode=6; udp.close();}); udp.send('synthetic',9,'127.0.0.1',e=>{if(!e || !['EACCES','EPERM'].includes(e.code)) process.exitCode=6; try{udp.close();}catch{}});
      if(fs.readFileSync(${JSON.stringify(path.join(job, "allowed"))},'utf8') !== 'allowed') process.exit(2);
      for(const file of [${JSON.stringify(path.join(root, "denied"))}, '/proc/${process.pid}/environ']) {
        try { fs.readFileSync(file); process.exit(3); } catch(e) { if(!['EACCES','EPERM'].includes(e.code)) process.exit(4); }
      }
      for(const address of [{port:1,host:'127.0.0.1'}, '/tmp/auto-agent-actions-unused.sock']) {
        const socket=net.connect(address); socket.on('error',e=>{if(!['EACCES','EPERM'].includes(e.code)) process.exitCode=5;});
      }`;
    const result = await executeProcess({
      command: binary,
      args: [
        "--read",
        "/usr",
        "--read",
        "/bin",
        "--read",
        "/lib",
        ...((await access("/lib64").then(
          () => true,
          () => false,
        ))
          ? ["--read", "/lib64"]
          : []),
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
      stdin: "",
      timeoutMs: 10000,
      maxOutputBytes: 1024,
      environment: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    });
    if (result.exitCode !== 0 || result.timedOut || result.outputTruncated)
      throw new CodexExecutionError(
        "per-job isolation preflight failed closed",
        result,
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
