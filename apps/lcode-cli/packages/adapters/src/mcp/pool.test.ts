import assert from "node:assert/strict";
import test from "node:test";
import type { McpPort, McpServerConfig, McpServerStatus } from "@lcode/contracts";
import { createMcpConnectionPool } from "./pool.js";

const config: McpServerConfig = {
  type: "http",
  url: "https://mcp.example.test/tools",
  isolation: "workspace",
};

function fakeAdapter(serverName: string, onClose?: () => void) {
  let connects = 0;
  let closes = 0;
  let pings = 0;
  let ping: () => Promise<boolean> = async () => true;
  let status: McpServerStatus = {
    status: "connected",
    transport: "http",
    toolCount: 0,
    updatedAt: new Date(0).toISOString(),
  };
  const adapter: McpPort = {
    async callTool() {
      return { content: [] };
    },
    async close() {
      closes += 1;
      onClose?.();
    },
    async connectConfiguredServers() {
      return { statuses: { [serverName]: status }, tools: [] };
    },
    async connectServer() {
      connects += 1;
      status = { ...status, status: "connected" };
      return status;
    },
    async disconnectServer() {
      return { ...status, status: "disconnected" };
    },
    async listTools() {
      return [];
    },
    async pingServer() {
      pings += 1;
      return await ping();
    },
    async status() {
      return { [serverName]: status };
    },
  };
  return {
    adapter,
    counts: () => ({ connects, closes, pings }),
    setPing: (next: () => Promise<boolean>) => {
      ping = next;
    },
  };
}

test("workspace identity shares leases while session isolation and distinct identities stay separate", async () => {
  const created: ReturnType<typeof fakeAdapter>[] = [];
  const pool = createMcpConnectionPool({
    idleGraceMs: 0,
    createAdapter: ({ serverName }) => {
      const fake = fakeAdapter(serverName);
      created.push(fake);
      return fake.adapter;
    },
  });
  try {
    const first = pool.acquireLease({ sessionId: "first" });
    const second = pool.acquireLease({ sessionId: "second" });
    await first.connectServer("shared", config, {
      workspaceIdentity: " remote:one ",
      workingDirectory: "/same",
    });
    await second.connectServer("shared", config, {
      workspaceIdentity: "remote:one",
      workingDirectory: "/different",
    });
    assert.equal(created.length, 1);
    await first.close();
    assert.equal(created[0]!.counts().closes, 0);
    await second.close();
    assert.equal(created[0]!.counts().closes, 1);

    const third = pool.acquireLease();
    const fourth = pool.acquireLease();
    await third.connectServer("shared", config, {
      workspaceIdentity: "remote:one",
      workingDirectory: "/same",
    });
    await fourth.connectServer("shared", config, {
      workspaceIdentity: "remote:two",
      workingDirectory: "/same",
    });
    assert.equal(pool.stats().activeConnections, 2);
    await third.connectServer("private", { ...config, isolation: "session" });
    await fourth.connectServer("private", { ...config, isolation: "session" });
    assert.equal(pool.stats().activeConnections, 4);
  } finally {
    await pool.close();
  }
});

test("concurrent revalidation pings and reconnects once without replacing the leased entry", async () => {
  const fake = fakeAdapter("shared");
  const pool = createMcpConnectionPool({ createAdapter: () => fake.adapter, idleGraceMs: 0 });
  try {
    const first = pool.acquireLease();
    const second = pool.acquireLease();
    await first.connectServer("shared", config);
    await second.connectServer("shared", config);
    const pingResult = Promise.withResolvers<boolean>();
    fake.setPing(() => pingResult.promise);
    const a = first.connectServer("shared", config, { revalidate: true });
    const b = second.connectServer("shared", config, { revalidate: true });
    pingResult.resolve(false);
    await Promise.all([a, b]);
    assert.deepEqual(fake.counts(), { connects: 2, closes: 0, pings: 1 });
    assert.equal((await second.status()).shared?.status, "connected");
    assert.deepEqual(await first.callTool({ serverName: "shared", toolName: "noop" }), {
      content: [],
    });
  } finally {
    await pool.close();
  }
});

for (const operation of ["close", "reconfigure"] as const) {
  test(`lease ${operation} snapshots names before reentrant cleanup adds another server`, async () => {
    const closed: string[] = [];
    let lease: McpPort;
    let inserted: Promise<McpServerStatus> | undefined;
    const pool = createMcpConnectionPool({
      idleGraceMs: 0,
      createAdapter: ({ serverName }) =>
        fakeAdapter(serverName, () => {
          closed.push(serverName);
          if (serverName === "first") {
            inserted = lease.connectServer("added-during-cleanup", config);
          }
        }).adapter,
    });
    try {
      lease = pool.acquireLease();
      await lease.connectServer("first", config);
      await lease.connectServer("second", config);
      // 清理回调可重入并追加 lease；本轮必须只处理开始时的快照，不能改成 Map 的 live iteration。
      if (operation === "close") await lease.close();
      else await lease.connectConfiguredServers({});
      await inserted;
      assert.deepEqual(closed, ["first", "second"]);
      assert.equal(pool.stats().activeConnections, 1);
      assert.equal((await lease.status())["added-during-cleanup"]?.status, "connected");
    } finally {
      await pool.close();
    }
  });
}

test("pool close attempts every adapter even when one close fails", async () => {
  const closed: string[] = [];
  const pool = createMcpConnectionPool({
    createAdapter: ({ serverName }) =>
      fakeAdapter(serverName, () => {
        closed.push(serverName);
        if (serverName === "first") throw new Error("fixture close failure");
      }).adapter,
  });
  const lease = pool.acquireLease();
  await lease.connectServer("first", config);
  await lease.connectServer("second", config);
  await pool.close();
  assert.deepEqual(closed, ["first", "second"]);
  assert.deepEqual(pool.stats(), { activeConnections: 0, pendingCloseConnections: 0 });
  assert.throws(() => pool.acquireLease(), /pool is closed/);
});
