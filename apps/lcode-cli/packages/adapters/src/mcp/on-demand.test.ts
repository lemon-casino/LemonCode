import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import type { McpServerConfig } from "@lcode/contracts";
import { createMcpAdapter } from "./index.js";
import { LCodeConfigFileSchema } from "../config/schema.js";
import { summarizeMcpPoolStartup } from "./pool-startup.js";

test("deferred discovery is not reported as a failed process startup", () => {
  assert.deepEqual(
    summarizeMcpPoolStartup(
      new Map([
        [
          "fixture",
          { type: "stdio", command: "fixture", source: { kind: "builtin" }, onDemandTools: [] },
        ],
      ]),
      {
        fixture: { status: "disconnected", transport: "stdio", toolCount: 0, updatedAt: "fixture" },
      },
    ),
    { configuredCount: 1, connectedCount: 0, failedCount: 0, processCount: 0 },
  );
});

test("public config cannot inject trusted on-demand descriptors", () => {
  assert.equal(
    LCodeConfigFileSchema.safeParse({
      mcp: { servers: { fixture: { type: "stdio", command: "fixture", onDemandTools: [] } } },
    }).success,
    false,
  );
});

test("trusted on-demand tools are discoverable without spawn and concurrent first calls share connection", async (t) => {
  let connects = 0;
  let failNext = false;
  t.mock.method(Client.prototype, "connect", async () => {
    connects++;
    if (failNext) {
      failNext = false;
      throw new Error("fixture startup memory pressure");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  t.mock.method(Client.prototype, "close", async () => {});
  t.mock.method(Client.prototype, "getProtocolEra", () => "legacy");
  t.mock.method(Client.prototype, "getNegotiatedProtocolVersion", () => undefined);
  t.mock.method(Client.prototype, "listTools", async () => ({
    tools: [{ name: "js", inputSchema: { type: "object" } }],
  }));
  t.mock.method(Client.prototype, "callTool", async () => ({ content: [] }));
  const adapter = createMcpAdapter();
  try {
    const servers: Record<string, McpServerConfig> = {
      node_repl: {
        type: "stdio",
        command: "unused-fixture",
        source: { kind: "builtin" },
        onDemandTools: [{ toolName: "js", inputSchema: { type: "object" } }],
      },
    };
    const snapshot = await adapter.connectConfiguredServers(servers);
    assert.equal(connects, 0);
    assert.equal(snapshot.statuses.node_repl?.status, "disconnected");
    assert.equal(snapshot.tools[0]?.toolName, "js");
    await Promise.all(
      [1, 2, 3].map(() => adapter.callTool({ serverName: "node_repl", toolName: "js" })),
    );
    assert.equal(connects, 1);
    assert.equal((await adapter.status()).node_repl?.status, "connected");
    await adapter.disconnectServer("node_repl");
    failNext = true;
    await assert.rejects(adapter.callTool({ serverName: "node_repl", toolName: "js" }));
    assert.equal((await adapter.status()).node_repl?.status, "failed");
    const rediscovered = await adapter.connectConfiguredServers(servers);
    assert.equal(rediscovered.tools.length, 1);
    assert.equal(rediscovered.statuses.node_repl?.status, "failed");
    assert.equal(connects, 2, "rediscovery must not restart a failed process in the background");
    await adapter.callTool({ serverName: "node_repl", toolName: "js" });
    assert.equal(connects, 3, "failed on-demand startup is retryable by the next explicit call");
  } finally {
    await adapter.close();
  }
});
