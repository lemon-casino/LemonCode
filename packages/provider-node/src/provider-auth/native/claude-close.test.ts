import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeClaudeChild } from "./claude-close.js";

for (const graceful of [true, false])
  test(
    `Claude child ${graceful ? "flushes stdin EOF" : "escalates an unresponsive process"} before close confirmation`,
    { timeout: 3000 },
    async () => {
      const source = graceful
        ? "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('flushed'));process.stdout.write('ready');"
        : "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.stdout.write('ready');";
      const child = spawn(process.execPath, ["-e", source], { windowsHide: true, stdio: "pipe" });
      child.stderr.resume();
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      const closed = once(child, "close").then(() => {});
      try {
        await once(child.stdout, "data");
        closeClaudeChild(child, closed);
        await closed;
        if (graceful) {
          assert.match(output, /flushed/);
          assert.equal(child.killed, false);
        } else assert.equal(child.killed, true);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
      }
    },
  );
