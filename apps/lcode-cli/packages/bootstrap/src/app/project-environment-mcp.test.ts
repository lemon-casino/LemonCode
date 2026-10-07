import assert from "node:assert/strict";
import { resolve as resolvePath } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { test } from "node:test";
import type {
  ExecutionEnvOverlay, McpConnectOptions, McpPort, McpServerConfig, McpServerStatus,
} from "@lcode/contracts";
import {
  createProjectEnvironmentCloseBarrier, createProjectScopedMcpPort,
} from "./project-environment-mcp.js";
import {
  createProjectScopedExecutionPort, type ProjectEnvironmentOverlayResolver,
} from "./project-environment-execution.js";

const cwd = resolvePath("fixture-checkout");
const config: McpServerConfig = { type: "stdio", command: "node", cwd: "tools" };
const frozen: ExecutionEnvOverlay = {
  base: "inherit", set: { PATH: "frozen-tools", TEMP: "frozen-temp" }, unset: ["REMOVED"],
};
const environmentRef = { environmentId: "a".repeat(32), revision: 1, manifestDigest: "manifest-a" };
function fakePort() {
  const seen: Array<{ name: string; config: McpServerConfig; options?: McpConnectOptions }> = [];
  const status: McpServerStatus = {
    status: "connected", transport: "stdio", toolCount: 0, updatedAt: new Date(0).toISOString(),
  };
  const port: McpPort = {
    async connectServer(name, value, options) { seen.push({ name, config: value, options }); return status; },
    async connectConfiguredServers(servers, options) {
      for (const [name, value] of Object.entries(servers)) seen.push({ name, config: value, options });
      return { statuses: {}, tools: [] };
    },
    async disconnectServer() { return undefined; }, async status() { return {}; },
    async listTools() { return []; }, async callTool() { return { content: [] }; },
    async close() {},
  };
  return { port, seen };
}

test("both connect entrypoints freeze actual cwd and reauthorize every transport spawn", async () => {
  const { port, seen } = fakePort();
  const resolved: Array<string | undefined> = [];
  const originalEnv = { ...process.env };
  const scoped = createProjectScopedMcpPort(port, async (path) => {
    resolved.push(path); return frozen;
  }, { workingDirectory: cwd, environmentRef });
  await scoped.connectServer("direct", { ...config, env: { PLUGIN_VALUE: "kept" } });
  await scoped.connectConfiguredServers({ batch: config });
  assert.deepEqual(resolved, [resolvePath(cwd, "tools"), resolvePath(cwd, "tools")]);
  for (const { config: wrapped } of seen) {
    assert.equal(wrapped.type, "stdio");
    if (wrapped.type !== "stdio") assert.fail();
    assert.equal(wrapped.cwd, resolvePath(cwd, "tools"));
    assert.equal(wrapped.env?.PATH, "frozen-tools");
    assert.deepEqual(wrapped.projectEnvironment?.environmentRef, environmentRef);
    await wrapped.projectEnvironment!.authorizeSpawn();
  }
  assert.equal(resolved.length, 4);
  assert.equal(seen[0]!.config.type === "stdio" && seen[0]!.config.env?.PLUGIN_VALUE, "kept");
  assert.ok(isDeepStrictEqual({ ...process.env }, originalEnv), "Host environment must remain unchanged");
  assert.equal(config.cwd, "tools");
  await scoped.close();
});

test("Windows frozen keys and unset cannot be replaced; HTTP/SSE/disabled/builtin stay unchanged", async () => {
  const { port, seen } = fakePort();
  let resolves = 0;
  const scoped = createProjectScopedMcpPort(port, async () => { resolves++; return frozen; }, {
    workingDirectory: cwd, platform: "win32",
  });
  const overrides: Record<string, string>[] = [{ Path: "other" }, { temp: "other" }, { removed: "revived" }];
  for (const env of overrides) {
    await assert.rejects(scoped.connectServer("bad", { ...config, env }), /frozen|override|removed/i);
  }
  assert.equal(seen.length, 0);
  const bypass: Record<string, McpServerConfig> = {
    http: { type: "http", url: "https://mcp.example.test", auth: { type: "lcode_official", provider: "jwt_token" } },
    sse: { type: "sse", url: "https://mcp.example.test/events" },
    disabled: { ...config, enabled: false },
    builtin: { ...config, command: process.execPath, source: { kind: "builtin" } },
  };
  const before = resolves;
  await scoped.connectConfiguredServers(bypass);
  assert.equal(resolves, before);
  for (const item of seen) assert.equal(item.config, bypass[item.name]);
  await scoped.connectServer("same-path", { ...config, env: { Path: frozen.set!.PATH } });
  const wrapped = seen.at(-1)!.config;
  assert.equal(wrapped.type, "stdio");
  if (wrapped.type !== "stdio") assert.fail();
  assert.deepEqual(Object.keys(wrapped.env!).filter((key) => key.toUpperCase() === "PATH"), ["PATH"]);
  await scoped.close();
});

test("resolver absence preserves legacy config; Host errors, stale overlay and abort never spawn", async () => {
  const { port, seen } = fakePort();
  const legacy = createProjectScopedMcpPort(port, async () => undefined);
  await legacy.connectServer("legacy", config);
  assert.equal(seen[0]!.config, config);
  const denied = createProjectScopedMcpPort(port, async () => { throw new Error("binding fenced"); });
  await assert.rejects(denied.connectServer("denied", config), /binding fenced/);
  await assert.rejects(denied.connectConfiguredServers({ denied: config }), /binding fenced/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(legacy.connectServer("aborted", config, { signal: aborted.signal }), /abort/i);
  assert.equal(seen.length, 1);
  let overlay = frozen;
  const scoped = createProjectScopedMcpPort(port, async () => overlay, { workingDirectory: cwd });
  await scoped.connectServer("frozen", config);
  overlay = { ...frozen, set: { ...frozen.set, PATH: "changed" } };
  const wrapped = seen[1]!.config;
  if (wrapped.type !== "stdio") assert.fail();
  await assert.rejects(wrapped.projectEnvironment!.authorizeSpawn(), /stale|changed/i);
  await scoped.close();
});

test("closing during Host resolution prevents delegation and late child spawn", async () => {
  const { port, seen } = fakePort();
  const pending = Promise.withResolvers<ExecutionEnvOverlay>();
  let released = 0;
  const resolver: ProjectEnvironmentOverlayResolver = () => pending.promise;
  resolver.close = async () => { released++; };
  const scoped = createProjectScopedMcpPort(port, resolver);
  const connecting = assert.rejects(scoped.connectServer("pending", config), /clos/i);
  const closing = scoped.close();
  pending.resolve(frozen);
  await connecting; await closing;
  assert.equal(seen.length, 0);
  assert.equal(released, 1);
  await assert.rejects(scoped.connectServer("late", config), /clos/i);
});

test("shared resolver waits for both real owners, is idempotent, and never releases on failed/unknown close", async () => {
  const events: string[] = [];
  const resolver: ProjectEnvironmentOverlayResolver = async () => frozen;
  resolver.close = async () => { events.push("released"); };
  const owners = createProjectEnvironmentCloseBarrier(resolver, ["execution", "mcp"]);
  const exit = Promise.withResolvers<void>();
  const { port } = fakePort();
  port.close = async () => { await exit.promise; events.push("mcp-exited"); };
  const mcp = createProjectScopedMcpPort(port, owners.mcp!);
  const execution = createProjectScopedExecutionPort({
    async run() { throw new Error("unused"); },
    async close() { events.push("execution-exited"); },
  }, owners.execution!);
  const closing = mcp.close();
  await execution.close!();
  assert.deepEqual(events, ["execution-exited"]);
  exit.resolve(); await closing; await mcp.close(); await execution.close!();
  assert.deepEqual(events, ["execution-exited", "mcp-exited", "released"]);

  for (const failure of ["owner", "probe", "borrowed"] as const) {
    let releases = 0;
    const failedResolver: ProjectEnvironmentOverlayResolver = async () => frozen;
    failedResolver.close = async () => { releases++; };
    const failedOwners = createProjectEnvironmentCloseBarrier(failedResolver, ["execution", "mcp"]);
    const fake = fakePort();
    const wrapped = createProjectScopedMcpPort(fake.port, failedOwners.mcp!);
    await wrapped.connectServer("fixture", config);
    if (failure === "owner") fake.port.close = async () => { throw new Error("exit unconfirmed"); };
    if (failure === "probe") {
      const prepared = fake.seen[0]!.config;
      if (prepared.type !== "stdio") assert.fail();
      prepared.projectEnvironment!.reportCloseFailure(new Error("probe exit unconfirmed"));
    }
    await failedOwners.execution! .close!();
    if (failure !== "borrowed") await assert.rejects(wrapped.close(), /unconfirmed/);
    assert.equal(releases, 0);
  }
});
