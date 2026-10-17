// 真实构建产物的隔离回归入口；由外部 cgroup 限制资源，不接触用户 HOME 或现有 Agent。
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LCodeAgentProcessManager } from "../../services/src/lcode-agent/lcodeAgentProcessManager.js";
import { createMcpAdapter } from "../../../apps/lcode-cli/packages/adapters/src/mcp/index.js";
import { createMcpConnectionPool } from "../../../apps/lcode-cli/packages/adapters/src/mcp/pool.js";
import { resolveBuiltInNodeReplMcpServers } from "../../../apps/lcode-cli/packages/bootstrap/src/app/built-in-node-repl.js";
import { readRuntimeMemorySnapshot } from "@lcode/shared/node";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { ChannelClient, Emitter, ProxyChannel, SocketProtocol } from "@lcode/rpc";
import type { ILCodeAgentService } from "@lcode/services";
import { performHandshake } from "../src/remote/handshake.js";
import { wrapStdioStream } from "../src/remote/stdio-socket.js";

const directory = process.argv[2]!;
assert.ok(directory?.startsWith("/tmp/lcode-memory-regression-"));
const workspacePath = join(directory, "workspace");
const cliEntry = join(directory, "lcode.cjs");
const membership = await readFile("/proc/self/cgroup", "utf8");
const cgroup = "/sys/fs/cgroup" + /^0::(.*)$/m.exec(membership)![1];
const phase = async (name: string, details: object = {}) => {
  const values = await Promise.all(
    [
      "memory.current",
      "memory.peak",
      "memory.events",
      "cpu.max",
      "cpuset.cpus.effective",
      "memory.max",
      "memory.swap.max",
    ].map(async (file) => [file, (await readFile(join(cgroup, file), "utf8")).trim()]),
  );
  process.stdout.write(
    JSON.stringify({ phase: name, resources: Object.fromEntries(values), ...details }) + "\n",
  );
};
const manager = new LCodeAgentProcessManager({
  commandResolver: () => ({
    command: process.execPath,
    args: [cliEntry, "app-server", "--stdio"],
    supportsStorageStartup: true,
  }),
});
const logger = {
  debug: () => {},
  info: () => {},
  warn: (message: string, meta?: object) =>
    process.stdout.write(JSON.stringify({ message, ...meta }) + "\n"),
  error: (message: string, meta?: object) =>
    process.stdout.write(JSON.stringify({ message, ...meta }) + "\n"),
  child: () => logger,
};
const pool = createMcpConnectionPool({
  idleGraceMs: 0,
  createAdapter: () => createMcpAdapter({ logger }),
});
const lease = pool.acquireLease({ sessionId: "memory-regression" });
try {
  await mkdir(workspacePath, { recursive: true });
  const server = spawn(process.execPath, [join(directory, "lcode-server.cjs")], {
    cwd: directory,
    stdio: "pipe",
  });
  const serverClose = once(server, "close");
  const closeEvent = new Emitter<number>();
  server.on("close", (code) => closeEvent.fire(code ?? -1));
  server.stderr.resume();
  const stream = {
    stdin: server.stdin,
    stdout: server.stdout,
    stderr: server.stderr,
    onClose: closeEvent.event,
  };
  const hello = await performHandshake(stream, "memory-regression", 15_000);
  if (hello.remaining) server.stdout.unshift(hello.remaining);
  const protocol = new SocketProtocol(wrapStdioStream(stream));
  const remote = new ChannelClient(protocol);
  try {
    const agent = ProxyChannel.toService<ILCodeAgentService>(remote.getChannel("lcode-agent"));
    await agent.helloConversationV4();
    await agent
      .subscribeSessionsIndexV4({ workspacePath, runtimePolicy: "existing-only" })
      .catch(() => undefined);
    await agent.getWorkspaceRuntimeIdentity({ workspacePath }).catch(() => undefined);
    const pids = [
      ...new Set(
        (await readFile(join(cgroup, "cgroup.procs"), "utf8"))
          .trim()
          .split(/\s+/)
          .filter((pid) => Number(pid) > 0),
      ),
    ];
    assert.equal(pids.length, 2, "cold remote connection must only contain driver and server");
    await phase("cold-remote-server-with-passive-subscriptions", { processes: pids.length });
  } finally {
    remote.dispose();
    protocol.dispose();
    server.stdin.end();
    await serverClose;
    closeEvent.dispose();
  }
  await phase("cold-host", { snapshot: await readRuntimeMemorySnapshot() });
  assert.equal(manager.getExistingClient({ workspacePath }), undefined);
  const clients = await Promise.all([
    manager.getClient({ workspacePath }),
    manager.getClient({ workspacePath }),
  ]);
  assert.equal(clients[0], clients[1]);
  const client = clients[0]!;
  client.onRequest((request) => {
    if (request.method === "session/requestRuntimePreferences") {
      void client.respond(request.id, {
        askUserQuestionAutoResolutionEnabled: true,
        nativeSearchEnhancementsEnabled: true,
        memoryEnabled: true,
        sessionRecallEnabled: true,
      });
    } else
      void client.respondError(request.id, {
        code: -32601,
        message: `Unexpected fixture callback: ${request.method}`,
      });
  });
  const workspace = { workspacePath, workspaceKey: workspacePath };
  await client.request("workspace/readPresentation", { workspace }, undefined, {
    timeoutMs: 30_000,
  });
  await delay(500);
  await phase("agent-ready", { processes: manager.listOwnedWorkspaceTargets().length });
  const created = await client.request(
    "session/create",
    { workspace, persistence: "deferred", mode: "build" },
    undefined,
    { timeoutMs: 30_000 },
  );
  assert.ok(created && typeof created === "object");
  await phase("agent-session-created");
  await assert.rejects(manager.getClient({ workspacePath: directory }), /memory budget/i);
  const pluginRoot = join(directory, "node-repl-host");
  const plugins = [
    { id: "browser-use@lcode-official", enabled: true, rootPath: join(directory, "browser-use") },
    { id: "computer-use@lcode-official", enabled: true, rootPath: join(directory, "computer-use") },
    { id: "node-repl-host@lcode-official", enabled: true, rootPath: pluginRoot },
  ];
  // 使用实际官方 ID，避免依赖 marketplace 展示名称。
  const definitions =
    await import("../../../apps/lcode-cli/packages/bootstrap/src/app/official-plugin-definitions.js");
  plugins[0]!.id = definitions.OFFICIAL_BROWSER_USE_PLUGIN_ID;
  plugins[1]!.id = definitions.OFFICIAL_CUA_PLUGIN_ID;
  plugins[2]!.id = definitions.OFFICIAL_NODE_REPL_HOST_PLUGIN_ID;
  const servers = resolveBuiltInNodeReplMcpServers({
    pluginOutcome: { plugins } as never,
    workingDirectory: workspacePath,
  });
  assert.equal(Object.keys(servers).length, 1);
  const config = servers.node_repl!;
  assert.equal(config.type, "stdio");
  if (config.type !== "stdio") throw new Error("expected stdio");
  assert.equal(config.args?.at(-1), join(pluginRoot, "dist/mcp/server.js"));
  const catalog = await lease.connectConfiguredServers(servers, {
    workingDirectory: workspacePath,
    workspaceIdentity: "memory-regression",
  });
  assert.equal(catalog.tools.length, 1);
  assert.equal(catalog.statuses.node_repl?.status, "disconnected");
  await phase("all-capabilities-enabled-without-repl");
  const call = (code: string, sessionId = "memory-regression", signal?: AbortSignal) =>
    lease.callTool(
      {
        serverName: "node_repl",
        toolName: "js",
        arguments: { code, title: "内存回归", timeout_ms: 10_000 },
        trace: { traceId: "memory-regression", spanId: "fixture-call", sessionId },
        workspacePath,
        deliveryKind: "desktop-continuous",
      },
      { timeoutMs: 15_000, signal },
    );
  const result = await call("nodeRepl.write(6 * 7)").catch(async (error) => {
    await phase("first-js-failed", { statuses: await lease.status() });
    throw error;
  });
  assert.notEqual(result.isError, true);
  assert.match(JSON.stringify(result.content), /42/);
  await phase("first-js-completed");
  const repeatedCalls = 100;
  for (let index = 0; index < repeatedCalls; index++) {
    assert.notEqual((await call("nodeRepl.write('repeat')")).isError, true);
    if (index === 19) await phase("twenty-js-completed");
  }
  await phase("repeated-js-completed", { calls: repeatedCalls });
  const holding = call(
    "await new Promise(r => setTimeout(r, 1000)); nodeRepl.write('first')",
    "parallel-first",
  );
  await delay(150);
  const busy = await call("nodeRepl.write('second')", "parallel-second").catch((error: Error) => ({
    isError: true,
    message: error.message,
  }));
  assert.equal(busy.isError, true);
  await holding;
  assert.notEqual((await call("nodeRepl.write('after-busy')")).isError, true);
  const aborted = new AbortController();
  const pending = call("await new Promise(r => setTimeout(r, 5000))", "cancelled", aborted.signal);
  await delay(200);
  aborted.abort();
  await assert.rejects(pending);
  // MCP caller 的取消先完成，服务端回收屏障通过同一 session 的下一调用检验。
  assert.notEqual((await call("nodeRepl.write('after-cancel')", "cancelled")).isError, true);
  const exhausted = await call(
    "const values=[]; while(true) values.push(new Array(100000).fill(Math.random()))",
  ).catch((error: Error) => ({ isError: true, message: error.message }));
  assert.equal(exhausted.isError, true);
  assert.notEqual((await call("nodeRepl.write('after-heap-limit')")).isError, true);
  await phase("cancel-and-heap-recovery");
  const nativePressure = await call(
    "const {Buffer}=await import('node:buffer'); const values=[]; while(true){ values.push(Buffer.alloc(8*1024*1024,1)); await new Promise(r=>setTimeout(r,30)); }",
  ).catch((error: Error) => ({ isError: true, message: error.message }));
  assert.equal(nativePressure.isError, true);
  assert.match(JSON.stringify(nativePressure), /memory budget/i);
  assert.notEqual((await call("nodeRepl.write('after-native-pressure')")).isError, true);
  await phase("native-memory-pressure-recovery");
} finally {
  await lease.close();
  await pool.close();
  await manager.disposeAllAndWait();
  await phase("all-processes-reclaimed");
}
const reopened = new LCodeAgentProcessManager({
  commandResolver: () => ({
    command: process.execPath,
    args: [cliEntry, "app-server", "--stdio"],
    supportsStorageStartup: true,
  }),
});
try {
  const nextWorkspace = join(directory, "reopened-workspace");
  await mkdir(nextWorkspace, { recursive: true });
  const client = await reopened.getClient({ workspacePath: nextWorkspace });
  await client.request(
    "workspace/readPresentation",
    { workspace: { workspacePath: nextWorkspace, workspaceKey: nextWorkspace } },
    undefined,
    { timeoutMs: 30_000 },
  );
  await phase("new-workspace-after-previous-owner-cleanup");
} finally {
  await reopened.disposeAllAndWait();
}
const remaining = [
  ...new Set(
    (await readFile(join(cgroup, "cgroup.procs"), "utf8"))
      .trim()
      .split(/\s+/)
      .filter((pid) => Number(pid) > 0),
  ),
];
assert.deepEqual(remaining, [String(process.pid)], "no test-owned process remains");
const events = await readFile(join(cgroup, "memory.events"), "utf8");
assert.match(events, /^oom 0$/m);
assert.match(events, /^oom_kill 0$/m);
await phase("regression-completed-with-no-orphans");
