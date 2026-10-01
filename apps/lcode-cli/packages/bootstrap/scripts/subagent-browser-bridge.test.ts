import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { BrowserClientTransport } from "@lcode/core/browser-client";
import type { NodeReplSession } from "@lcode/core/repl";
import type { Logger } from "@lcode/contracts";
import {
  NODE_REPL_BROWSER_BROKER_SOCKET_ENV,
  NODE_REPL_BROWSER_BROKER_TOKEN_ENV,
} from "@lcode/shared";
import { browserFixture } from "../src/lcode-protocol/browser-control-broker.fixture.js";
import { createNodeReplBrowserBroker } from "../src/app/node-repl-browser-broker.js";

// 按 node-repl-host 的公开 exports 装载桥接 API；集成测试不向 bootstrap 添加生产依赖。
const hostRequire = createRequire(new URL("../../node-repl-host/package.json", import.meta.url));
const loadHostEntry = (entry: string) =>
  import(pathToFileURL(hostRequire.resolve(`@lcode/node-repl-host/${entry}`)).href);
const [browserBridge, cuaBridge, runtimeBridge] = await Promise.all([
  loadHostEntry("browser-bridge"),
  loadHostEntry("cua-bridge"),
  loadHostEntry("runtime-bridge"),
]);
const { createBrowserBridgeGlobals } = browserBridge;
const { createComputerUseBridgeGlobals, NODE_REPL_CUA_BRIDGE_SYMBOL } = cuaBridge;
const { NODE_REPL_BROWSER_BRIDGE_SYMBOL } = runtimeBridge;

test("trusted subagent/workflow node_repl metadata reaches the host through the scoped browser broker", async (t) => {
  const { port, requests } = browserFixture();
  assert.ok(port.createChildScope);
  const agentScope = port.createChildScope({ parentSessionId: "root", sessionId: "agent" });
  const actorScope = port.createChildScope({ parentSessionId: "remote", sessionId: "actor" });
  const logger = { debug() {}, warn() {}, error() {} } as unknown as Logger;
  const broker = createNodeReplBrowserBroker({ browserControlPort: port, logger });
  await broker.ready;
  const savedSocket = process.env[NODE_REPL_BROWSER_BROKER_SOCKET_ENV];
  const savedToken = process.env[NODE_REPL_BROWSER_BROKER_TOKEN_ENV];
  process.env[NODE_REPL_BROWSER_BROKER_SOCKET_ENV] = broker.socketPath;
  process.env[NODE_REPL_BROWSER_BROKER_TOKEN_ENV] = broker.token;
  t.after(async () => {
    if (savedSocket === undefined) delete process.env[NODE_REPL_BROWSER_BROKER_SOCKET_ENV];
    else process.env[NODE_REPL_BROWSER_BROKER_SOCKET_ENV] = savedSocket;
    if (savedToken === undefined) delete process.env[NODE_REPL_BROWSER_BROKER_TOKEN_ENV];
    else process.env[NODE_REPL_BROWSER_BROKER_TOKEN_ENV] = savedToken;
    await broker.close();
  });
  const makeBridge = (sessionId: string, runtime_scope: "main" | "subagent") => {
    const getActiveCall = () => ({
      generation: 1,
      requestMeta: { session_id: sessionId, turn_id: `turn-${sessionId}`, runtime_scope },
      signal: new AbortController().signal,
    });
    const input = {
      documentationRoot: "docs",
      generation: 1,
      getActiveCall,
      session: () => ({ mergeResponseMeta() {} }) as unknown as NodeReplSession,
    };
    const globals = createBrowserBridgeGlobals(input);
    const cuaGlobals = createComputerUseBridgeGlobals(input);
    if (runtime_scope === "subagent")
      assert.throws(
        () =>
          (
            cuaGlobals[NODE_REPL_CUA_BRIDGE_SYMBOL] as { assertAvailable(): void }
          ).assertAvailable(),
        /Computer Use is not available in subagent/,
      );
    return globals[NODE_REPL_BROWSER_BRIDGE_SYMBOL] as BrowserClientTransport;
  };
  const agent = makeBridge("agent", "subagent");
  const actor = makeBridge("actor", "main");
  assert.equal((await agent.list())[0].id, "iab-1");
  await agent.execute("iab-1", 2, { method: "newTab" });
  await actor.execute("iab-1", 2, { method: "newTab" });
  assert.equal(requests[0].sessionId, "agent");
  assert.equal(requests[0].turnId, "turn-agent");
  assert.equal(requests[2].workspaceKey, "remote-identity");
  assert.notEqual(requests[1].requestId, requests[2].requestId);
  process.env[NODE_REPL_BROWSER_BROKER_TOKEN_ENV] = "0".repeat(64);
  await assert.rejects(agent.list(), /not authorized/);
  process.env[NODE_REPL_BROWSER_BROKER_TOKEN_ENV] = broker.token;
  await agentScope.closeSession?.({ sessionId: "agent" });
  await assert.rejects(agent.list(), /not active/);
  await actor.list();
  await actorScope.closeSession?.({ sessionId: "actor" });
  assert.ok(
    requests.some(
      (r) =>
        r.sessionId === "actor" && (r.command as { method: string })?.method === "closeSession",
    ),
  );
});
