import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { NodeExecutionAdapter } from "./node-execution-adapter.js";

const worker = `const http=require("node:http"); const server=http.createServer((req,res)=>res.end("preview")); server.listen(0,"127.0.0.1",()=>process.stdout.write(JSON.stringify({port:server.address().port,pid:process.pid})+"\\n"));`;
const parent = `const {spawn}=require("node:child_process"); spawn(process.execPath,["-e",${JSON.stringify(worker)}],{stdio:["ignore","inherit","inherit"],windowsHide:true}); setInterval(()=>{},1000);`;

async function startPreview(
  adapter: NodeExecutionAdapter,
  cwd: string,
  sessionId: string,
  signal: AbortSignal,
) {
  const encoded = Buffer.from(parent).toString("base64");
  const nodePath = process.execPath.replaceAll("\\", "/");
  const started = await adapter.runBashWithBackgroundLifecycle(
    {
      command: {
        mode: "shell",
        shellProfile: "posix-bash",
        command: `"${nodePath}" -e "eval(Buffer.from('${encoded}','base64').toString())"`,
      },
      cwd,
      trace: { traceId: sessionId, sessionId } as never,
    },
    { mode: "explicit" },
    { signal },
  );
  assert.equal(started.kind, "backgrounded");
  if (started.kind !== "backgrounded") throw new Error("Preview did not start");
  // 后台 Bash 的 stdout 不再推送给前台，按真实只读输出契约等就绪事实，而不是固定等待。
  let server: { port: number; pid: number } | undefined;
  while (!server) {
    const output = await adapter.readBackgroundBashOutput(started.task.taskId, sessionId);
    if (output.kind === "output") {
      const json = output.output.match(/\{"port":\d+,"pid":\d+\}/)?.[0];
      if (json) server = JSON.parse(json);
    }
    if (!server) await setImmediate(undefined, { signal });
  }
  return {
    ...server,
    taskId: started.task.taskId,
    rootPid: started.task.pid,
    url: `http://127.0.0.1:${server.port}`,
  };
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test(
  "settling an owned preview stops its real HTTP child process, without stopping another session",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "lcode-preview-cleanup-"));
    const owned = new NodeExecutionAdapter({ outputRootDir: join(root, "owned") });
    const unrelated = new NodeExecutionAdapter({ outputRootDir: join(root, "unrelated") });
    try {
      const a = await startPreview(owned, root, "fixture-a", t.signal);
      const b = await startPreview(unrelated, root, "fixture-b", t.signal);
      assert.equal(await (await fetch(a.url)).text(), "preview");
      assert.equal(await (await fetch(b.url)).text(), "preview");
      await owned.cancelBackgroundTask(a.taskId);
      const ended = await owned.waitForBackgroundTask(a.taskId);
      assert.equal(ended?.status, "cancelled");
      assert.equal(ended?.result?.cancelled, true);
      assert.equal(isAlive(a.pid), false);
      if (a.rootPid) assert.equal(isAlive(a.rootPid), false);
      await assert.rejects(fetch(a.url, { signal: AbortSignal.timeout(1000) }));
      assert.equal(await (await fetch(b.url)).text(), "preview");
      assert.equal(isAlive(b.pid), true);
    } finally {
      await Promise.all([owned.close(), unrelated.close()]);
      await rm(root, { recursive: true, force: true });
    }
  },
);
