// 完整 Server/Agent/REPL 同处一个受限 cgroup；只使用独立测试 HOME 和目录。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ChannelClient, Emitter, ProxyChannel, SocketProtocol } from "@lcode/rpc";
import type { ILCodeAgentService } from "@lcode/services";
import { createMcpAdapter } from "../../../apps/lcode-cli/packages/adapters/src/mcp/index.js";
import { JsInputJsonSchema } from "../../../apps/lcode-cli/packages/contracts/src/tools/node-repl.js";
import { performHandshake } from "../src/remote/handshake.js";
import { wrapStdioStream } from "../src/remote/stdio-socket.js";

const directory = process.argv[2]!;
assert.ok(directory?.startsWith("/tmp/lcode-memory-regression-"));
const membership = await readFile("/proc/self/cgroup", "utf8");
const group = "/sys/fs/cgroup" + /^0::(.*)$/m.exec(membership)![1];
const processes = async () => [
  ...new Set(
    (await readFile(join(group, "cgroup.procs"), "utf8"))
      .trim()
      .split(/\s+/)
      .filter((pid) => Number(pid) > 0),
  ),
];
const phase = async (name: string) => {
  const fields = await Promise.all(
    [
      "memory.max",
      "memory.swap.max",
      "memory.current",
      "memory.peak",
      "memory.events",
      "cpu.max",
      "cpuset.cpus.effective",
    ].map(async (field) => [field, (await readFile(join(group, field), "utf8")).trim()]),
  );
  process.stdout.write(
    JSON.stringify({
      phase: name,
      resources: Object.fromEntries(fields),
      processes: (await processes()).length,
    }) + "\n",
  );
};
const server = spawn(process.execPath, [join(directory, "lcode-server.cjs")], {
  cwd: directory,
  stdio: "pipe",
  env: {
    ...process.env,
    LCODE_AGENT_SERVER_COMMAND: process.execPath,
    LCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([
      join(directory, "lcode.cjs"),
      "app-server",
      "--stdio",
    ]),
  },
});
const closed = once(server, "close");
const closeEvent = new Emitter<number>();
server.on("close", (code) => closeEvent.fire(code ?? -1));
server.stderr.resume();
const stream = {
  stdin: server.stdin,
  stdout: server.stdout,
  stderr: server.stderr,
  onClose: closeEvent.event,
};
const hello = await performHandshake(stream, "memory-rpc-regression", 15_000);
if (hello.remaining) server.stdout.unshift(hello.remaining);
const protocol = new SocketProtocol(wrapStdioStream(stream));
const channel = new ChannelClient(protocol);
const agent = ProxyChannel.toService<ILCodeAgentService>(channel.getChannel("lcode-agent"));
const mcp = createMcpAdapter();
const workspacePath = join(directory, "rpc-workspace");
try {
  await mkdir(workspacePath, { recursive: true });
  await agent.helloConversationV4();
  assert.equal((await processes()).length, 2);
  await phase("rpc-cold-connection");
  const list = (path: string) =>
    agent.listSessions({ workspacePath: path, runtimePolicy: "start-if-needed", limit: 10 });
  await Promise.all([list(workspacePath), list(workspacePath)]);
  assert.equal(
    (await processes()).length,
    3,
    "concurrent demand starts one Agent owned by the real Server",
  );
  const other = join(directory, "rpc-other-workspace");
  await mkdir(other, { recursive: true });
  await assert.rejects(list(other), /memory budget/i);
  await mcp.connectConfiguredServers({
    node_repl: {
      type: "stdio",
      command: process.execPath,
      args: [join(directory, "node-repl-host/dist/mcp/server.js")],
      env: { NODE_OPTIONS: "--max-old-space-size=96" },
      source: { kind: "builtin" },
      onDemandTools: [{ toolName: "js", inputSchema: JsInputJsonSchema }],
    },
  });
  assert.equal((await processes()).length, 3);
  const result = await mcp.callTool(
    {
      serverName: "node_repl",
      toolName: "js",
      arguments: { code: "nodeRepl.write(42)", title: "完整链路回归" },
    },
    { timeoutMs: 15_000 },
  );
  assert.notEqual(result.isError, true);
  assert.match(JSON.stringify(result.content), /42/);
  assert.equal((await processes()).length, 4);
  await phase("rpc-server-agent-repl-alive");
  await mcp.close();
  await agent.disposeWorkspace({ workspacePath });
  assert.equal((await processes()).length, 2);
  await phase("rpc-workspace-release-keeps-server");
  await list(other);
  assert.equal((await processes()).length, 3);
  await agent.disposeWorkspace({ workspacePath: other });
  assert.equal((await processes()).length, 2);
  await phase("rpc-new-workspace-after-release");
} finally {
  await mcp.close();
  channel.dispose();
  protocol.dispose();
  server.stdin.end();
  await closed;
  closeEvent.dispose();
}
assert.deepEqual(await processes(), [String(process.pid)]);
assert.match(await readFile(join(group, "memory.events"), "utf8"), /^oom_kill 0$/m);
await phase("rpc-regression-completed-no-orphans");
