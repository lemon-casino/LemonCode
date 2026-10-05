import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpConnectOptions, McpServerConfig } from "@lcode/contracts";
import { connectionKey } from "./pool-identity.js";

const config: McpServerConfig = {
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "C:/root"],
};

const options = (overrides: Partial<McpConnectOptions> = {}): McpConnectOptions => ({
  workingDirectory: "C:/checkout",
  ...overrides,
});

test("connection key is stable for the same environment reference", () => {
  const envRef = { environmentId: "a".repeat(32), revision: 1 };
  const a = connectionKey({ config, connectOptions: options({ environmentRef: envRef }), leaseId: "l1", serverName: "fs" });
  const b = connectionKey({ config, connectOptions: options({ environmentRef: envRef }), leaseId: "l1", serverName: "fs" });
  assert.equal(a, b);
});

test("connection key differs when the environment revision changes", () => {
  const l1 = connectionKey({
    config,
    connectOptions: options({ environmentRef: { environmentId: "a".repeat(32), revision: 1 } }),
    leaseId: "l1",
    serverName: "fs",
  });
  const l2 = connectionKey({
    config,
    connectOptions: options({ environmentRef: { environmentId: "a".repeat(32), revision: 2 } }),
    leaseId: "l1",
    serverName: "fs",
  });
  assert.notEqual(l1, l2);
});

test("connection key differs between distinct environments at the same revision", () => {
  const a = connectionKey({
    config,
    connectOptions: options({ environmentRef: { environmentId: "a".repeat(32), revision: 1 } }),
    leaseId: "l1",
    serverName: "fs",
  });
  const b = connectionKey({
    config,
    connectOptions: options({ environmentRef: { environmentId: "b".repeat(32), revision: 1 } }),
    leaseId: "l1",
    serverName: "fs",
  });
  assert.notEqual(a, b);
});

test("without environmentRef the key matches the legacy shape (backward compat)", () => {
  const legacy = connectionKey({ config, connectOptions: options(), leaseId: "l1", serverName: "fs" });
  const rebuilt = connectionKey({ config, connectOptions: options(), leaseId: "l1", serverName: "fs" });
  assert.equal(legacy, rebuilt);
  // 非托管连接不得与任何托管连接碰撞。
  const managed = connectionKey({
    config,
    connectOptions: options({ environmentRef: { environmentId: "a".repeat(32), revision: 1 } }),
    leaseId: "l1",
    serverName: "fs",
  });
  assert.notEqual(legacy, managed);
});
