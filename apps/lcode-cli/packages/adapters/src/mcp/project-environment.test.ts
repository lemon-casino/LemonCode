import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpPort, McpProjectEnvironment, McpServerConfig, McpServerStatus } from "@lcode/contracts";
import { connectionKey } from "./pool-identity.js";
import { createMcpConnectionPool } from "./pool.js";
import { buildProjectMcpStdioEnv } from "./project-environment.js";

const runtime = (digest = "manifest-a"): McpProjectEnvironment => ({
  ownerId: "app-a",
  environmentRef: { environmentId: "a".repeat(32), revision: 1, manifestDigest: digest },
  overlay: { set: { PATH: "/frozen" }, unset: ["REMOVED"] },
  authorizeSpawn: async () => {}, reportCloseFailure() {},
});
const config = (digest?: string): McpServerConfig => ({
  type: "stdio", command: "node", isolation: "workspace", projectEnvironment: runtime(digest),
});
const status: McpServerStatus = {
  status: "connected", transport: "stdio", toolCount: 0, updatedAt: new Date(0).toISOString(),
};
const adapter = (close: () => Promise<void>): McpPort => ({
  close, async connectServer() { return status; }, async connectConfiguredServers() { return { statuses: {}, tools: [] }; },
  async status() { return { fixture: status }; }, async listTools() { return []; },
  async callTool() { return { content: [] }; }, async disconnectServer() { return undefined; },
});

test("managed stdio keys include manifest digest and app incarnation, not only environment revision", () => {
  const key = (value: McpServerConfig, leaseId = "session-a") => connectionKey({
    config: value, leaseId, serverName: "fixture", connectOptions: { workingDirectory: "/same" },
  });
  assert.equal(key(config()), key(config()));
  assert.notEqual(key(config()), key(config("manifest-b")));
  assert.notEqual(key(config()), key(config(), "session-b"));
});

test("final Windows env suppresses inherited SDK aliases and frozen unset, without mutating host env", () => {
  const inherited = { Path: "host", TEMP: "host-temp", REMOVED: "host", KEEP: "kept" };
  const sdkDefaults = { PATH: "sdk", TEMP: "sdk-temp", USERPROFILE: "sdk-home" };
  const overlay = { set: { Path: "frozen", TEMP: "frozen-temp" }, unset: ["REMOVED"] };
  const result = buildProjectMcpStdioEnv(inherited, overlay, "win32", sdkDefaults);
  assert.equal(result.PATH, "frozen");
  assert.equal(result.Path, undefined);
  assert.equal(result.TEMP, "frozen-temp");
  assert.equal(result.REMOVED, undefined);
  assert.equal(result.KEEP, "kept");
  assert.deepEqual(inherited, { Path: "host", TEMP: "host-temp", REMOVED: "host", KEEP: "kept" });
  const empty = buildProjectMcpStdioEnv(inherited, { base: "empty", set: { PATH: "only" } }, "win32", sdkDefaults);
  assert.equal(empty.PATH, "only");
  assert.equal(empty.USERPROFILE, undefined);
  assert.equal(empty.TEMP, undefined);
});

test("managed lease.close waits for real adapter completion and skips idle grace", async () => {
  const exited = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const pool = createMcpConnectionPool({
    idleGraceMs: 60_000,
    createAdapter: () => adapter(async () => { entered.resolve(); await exited.promise; }),
  });
  const lease = pool.acquireLease();
  await lease.connectServer("fixture", config());
  let closed = false;
  const closing = lease.close().then(() => { closed = true; });
  await entered.promise;
  assert.equal(closed, false);
  exited.resolve(); await closing;
  assert.equal(closed, true);
  assert.equal(pool.stats().activeConnections, 0);
  await pool.close();
});

test("managed leases never share app authorization and failed close remains observable", async () => {
  let created = 0;
  let allowClose = false;
  const pool = createMcpConnectionPool({ createAdapter: () => {
    created++;
    return adapter(async () => { if (!allowClose) throw new Error("exit unknown"); });
  } });
  const first = pool.acquireLease(); const second = pool.acquireLease();
  await first.connectServer("fixture", config()); await second.connectServer("fixture", config());
  assert.equal(created, 2);
  await assert.rejects(first.close(), /exit unknown/);
  await assert.rejects(first.close(), /exit unknown/);
  assert.equal(pool.stats().activeConnections, 2);
  allowClose = true;
  await second.close(); await pool.close();
});

test("managed retired config is fully closed before session lease can acknowledge shutdown", async () => {
  const exit = Promise.withResolvers<void>();
  let created = 0;
  const pool = createMcpConnectionPool({ createAdapter: () => {
    created++;
    return adapter(async () => { if (created === 1) await exit.promise; });
  } });
  const lease = pool.acquireLease();
  await lease.connectServer("fixture", config());
  let done = false;
  const removing = lease.connectConfiguredServers({}).then(() => { done = true; });
  await Promise.resolve();
  assert.equal(done, false);
  exit.resolve(); await removing; await lease.close(); await pool.close();
});
