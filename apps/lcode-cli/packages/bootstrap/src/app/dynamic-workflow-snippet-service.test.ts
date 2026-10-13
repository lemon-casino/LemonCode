import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { createRootTraceContext } from "@lcode/contracts";
import { createDynamicWorkflowSnippetService } from "./dynamic-workflow-snippet-service.js";

const TEMP_PREFIX = "lcode-snippet-execution-";

async function fixture(t: test.TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  const closed: Promise<void>[] = [];
  const originalSpawn = childProcess.spawn;
  const spawned = t.mock.method(
    childProcess,
    "spawn",
    (command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
      const child = originalSpawn(command, args, options);
      closed.push(new Promise<void>((resolveClose) => child.once("close", () => resolveClose())));
      return child;
    },
  );
  syncBuiltinESMExports();
  t.after(async () => {
    // 引擎结算可以先于子进程 close；Windows 仍锁着 cwd，清理等待真实 close 而不加 sleep/retry。
    await Promise.all(closed);
    spawned.mock.restore();
    syncBuiltinESMExports();
    assert.equal(dirname(resolve(cwd)), resolve(tmpdir()));
    assert.ok(cwd.startsWith(join(tmpdir(), TEMP_PREFIX)));
    await rm(cwd, { recursive: true, force: true });
  });
  // 此处只运行纯逻辑片段；任何意外的 world I/O 都必须让测试失败。
  const unavailable = new Proxy(
    {},
    {
      get: (_target, field) => {
        throw new Error(`unexpected world port access: ${String(field)}`);
      },
    },
  );
  const port = createDynamicWorkflowSnippetService({
    fileSystemPort: unavailable as never,
    executionPort: unavailable as never,
  });
  const evaluate = (code: string) =>
    port.evalSnippet({ code, cwd, timeoutMs: 5000, trace: createRootTraceContext() });
  return { evaluate, cwd };
}

test("real snippet compiler and child process execute code and capture logs", async (t) => {
  const h = await fixture(t);
  const result = await h.evaluate(
    'log("fixture executed"); return { ok: true, count: [1, 2, 3].filter(x => x > 1).length };',
  );
  assert.ok(result.kind === "completed", JSON.stringify(result));
  assert.deepEqual(result.artifact, { ok: true, count: 2 });
  assert.deepEqual(result.logs, ["fixture executed"]);
});

test("snippet cannot compile an actor and creates no execution files", async (t) => {
  const h = await fixture(t);
  const result = await h.evaluate('return agent("forbidden").ask("fixture");');
  assert.ok(result.kind === "diagnostics");
  assert.ok(result.diagnostics.some((item) => item.message.includes("agent")));
  assert.deepEqual(await readdir(h.cwd), []);
});

test("real execution failure preserves preceding logs", async (t) => {
  const h = await fixture(t);
  const result = await h.evaluate('log("before failure"); throw new Error("fixture failure");');
  assert.ok(result.kind === "failed", JSON.stringify(result));
  assert.match(result.error.message, /fixture failure/);
  assert.deepEqual(result.logs, ["before failure"]);
});
