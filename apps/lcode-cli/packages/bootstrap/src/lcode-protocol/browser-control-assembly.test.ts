import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createConnection } from "node:net";
import test from "node:test";
import type { BrowserControlPort, Logger } from "@lcode/contracts";
import { lcodeProtocolMethods } from "@lcode/shared";
import type { LCodeApp } from "../app/types.js";
import { createNodeReplBrowserBroker } from "../app/node-repl-browser-broker.js";
import { createSessionRecordForV4 } from "./server-operations.js";
import { LCodeProtocolAgentServer } from "./server.js";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";

test("production record assembly and shared socket consume the server Browser authority", async (t) => {
  const ports: BrowserControlPort[] = [];
  const server = new LCodeProtocolAgentServer({
    createLCodeApp(options) {
      assert.ok(options?.browserControlPort);
      ports.push(options.browserControlPort);
      return {
        sessionId: options.sessionId,
        runtime: { subscribeEvents: () => () => {}, beginShutdown() {} },
        getModel: () => undefined,
        listThoughtLevels: () => [],
        close: async () => {},
      } as unknown as LCodeApp;
    },
  });
  t.after(async () => {
    await server.shutdown();
    server.disposeProjections();
  });
  server.setNotificationSink((message) => {
    if (!("id" in message) || !("method" in message)) return;
    if (message.method === lcodeProtocolMethods.interactionBrowserList) {
      void server.handleMessage({
        id: message.id,
        result: {
          browsers: [
            {
              id: "fixture-browser",
              generation: 1,
              type: "iab",
              name: "Fixture",
              capabilities: {},
            },
          ],
        },
      });
    } else {
      void server.handleMessage({
        id: message.id,
        error: { code: -32601, message: "Fixture capability unavailable" },
      });
    }
  });
  // 使用实际 server context 和实际 record 装配；app/model/Host 仅受控替身。
  const context = (server as unknown as { context: LCodeProtocolAgentServerContext }).context;
  const { sessionId } = await createSessionRecordForV4(context, {
    workspace: { workspacePath: "fixture", workspaceKey: "fixture" },
    persistence: "deferred",
  });
  assert.equal(ports[0], server.browserControlPort);
  const childId = "assembly-child";
  const scope = ports[0].createChildScope!({ parentSessionId: sessionId, sessionId: childId });
  t.after(() => scope.closeSession!({ sessionId: childId }));
  const broker = createNodeReplBrowserBroker({
    browserControlPort: server.browserControlPort,
    logger: { debug() {}, warn() {}, error() {} } as unknown as Logger,
  });
  t.after(() => broker.close());
  await broker.ready;
  const socket = createConnection(broker.socketPath);
  t.after(() => socket.destroy());
  await once(socket, "connect");
  const received = once(socket, "data");
  socket.write(
    JSON.stringify({
      id: randomUUID(),
      token: broker.token,
      runtimeScope: "subagent",
      sessionId: childId,
      turnId: "turn",
      op: "list",
    }) + "\n",
  );
  const [data] = await received;
  const response = JSON.parse(data.toString());
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.browsers[0].id, "fixture-browser");
  socket.destroy();
});
