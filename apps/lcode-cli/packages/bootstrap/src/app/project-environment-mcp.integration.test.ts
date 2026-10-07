import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { createMcpAdapter, createMcpAdapterConnectionPool } from "@lcode/adapters/mcp";
import type { ExecutionEnvOverlay } from "@lcode/contracts";
import { createProjectScopedMcpPort } from "./project-environment-mcp.js";
import type { ProjectEnvironmentOverlayResolver } from "./project-environment-execution.js";

const serverSource = `
import { appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
const evidence = { pid: process.pid, executable: process.execPath, cwd: process.cwd(),
  path: process.env.PATH, temp: process.env.TEMP, removed: process.env.REMOVED,
  marker: process.env.MCP_FIXTURE_MARKER, home: process.env.USERPROFILE ?? process.env.HOME };
await appendFile(process.env.MCP_FIXTURE_LOG, JSON.stringify(evidence) + '\\n');
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'server/discover') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }) + '\\n');
  } else if (message.method === 'initialize') {
    reply(message.id, { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } });
  } else if (message.method === 'tools/list') {
    reply(message.id, { tools: [{ name: 'evidence', inputSchema: { type: 'object' } }] });
  } else if (message.method === 'tools/call') {
    reply(message.id, { content: [{ type: 'text', text: JSON.stringify(evidence) }] });
  } else if (message.method === 'ping') reply(message.id, {});
});
`;
interface Evidence { pid: number; executable: string; cwd: string; path: string; temp: string; removed?: string; marker: string; home?: string }

for (const pooled of [false, true]) {
  test(`real ${pooled ? "pool lease" : "adapter"} stdio probe/session/reconnect use frozen node, env and cwd`, { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "lcode-mcp-frozen-"));
    const bin = join(root, "bin"); const cwd = join(root, "checkout", "tools");
    const temp = join(root, "temp"); const log = join(root, "spawns.jsonl");
    const executable = join(bin, process.platform === "win32" ? "node.exe" : "node");
    const script = join(root, "server.mjs");
    await Promise.all([mkdir(bin), mkdir(cwd, { recursive: true }), mkdir(temp)]);
    await copyFile(process.execPath, executable); await writeFile(script, serverSource);
    const hostEnv = { ...process.env, REMOVED: "host-value" };
    const originalEnv = { ...process.env };
    const overlay: ExecutionEnvOverlay = {
      base: "inherit", set: { PATH: bin, TEMP: temp, TMP: temp, TMPDIR: temp }, unset: ["REMOVED"],
    };
    const authorized: Array<string | undefined> = [];
    let fenced = false; let released = false;
    const resolver: ProjectEnvironmentOverlayResolver = async (actualCwd) => {
      authorized.push(actualCwd);
      if (fenced) throw new Error("binding restoring fence");
      assert.equal(actualCwd, cwd); return overlay;
    };
    resolver.close = async () => { released = true; };
    const pool = pooled ? createMcpAdapterConnectionPool({ env: hostEnv, workingDirectory: root }) : undefined;
    const raw = pool?.acquireLease() ?? createMcpAdapter({ env: hostEnv, workingDirectory: root });
    const scoped = createProjectScopedMcpPort(raw, resolver, {
      workingDirectory: join(root, "checkout"),
      environmentRef: { environmentId: "a".repeat(32), revision: 1, manifestDigest: "fixture-manifest" },
    });
    const config = {
      type: "stdio" as const, command: "node", args: [script], cwd: "tools", protocolVersion: "auto" as const,
      timeoutMs: 5_000, isolation: "workspace" as const,
      env: { MCP_FIXTURE_LOG: log, MCP_FIXTURE_MARKER: "preserved" },
    };
    const readSpawns = async (): Promise<Evidence[]> => (await readFile(log, "utf8")).trim().split(/\r?\n/).map(line => JSON.parse(line));
    try {
      const connected = await scoped.connectServer("fixture", config);
      assert.equal(connected.status, "connected", connected.error);
      const spawns = await readSpawns();
      assert.equal(spawns.length, 2, "auto negotiation must create a probe sibling and a session child");
      assert.ok(authorized.length >= 3, "prepare and both actual spawns must consult Host");
      for (const child of spawns) {
        assert.equal(resolve(child.executable), executable);
        assert.equal(child.cwd, cwd); assert.equal(child.path, bin); assert.equal(child.temp, temp);
        assert.equal(child.removed, undefined); assert.equal(child.marker, "preserved");
      }
      await scoped.disconnectServer("fixture");
      await scoped.connectServer("fixture", config);
      assert.equal((await readSpawns()).length, 4);
      fenced = true;
      await scoped.disconnectServer("fixture");
      await assert.rejects(scoped.connectServer("fixture", config), /fence/);
      assert.equal((await readSpawns()).length, 4);
      assert.equal(released, false);
      await scoped.close();
      assert.equal(released, true);
      assert.ok(isDeepStrictEqual({ ...process.env }, originalEnv), "Host environment must remain unchanged");
      assert.equal(hostEnv.REMOVED, "host-value");
      assert.equal(basename(executable), process.platform === "win32" ? "node.exe" : "node");
    } finally {
      await scoped.close(); await pool?.close(); await rm(root, { force: true, recursive: true });
    }
  });
}
