import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  lcodeProtocolMethods,
  type LCodeProtocolNotification,
  type LCodeProtocolRequest,
} from "@lcode/shared";
import { LCodeProtocolAgentServer } from "./server.js";
import * as sessionMapper from "./session-mapper.js";
import * as plugins from "./plugins.js";
import * as subagentQuery from "./subagent-session-query.js";
import { createProtocolInteractionBroker } from "./interaction-broker.js";
import { createConversationV4Gateway } from "./v4-bridge.js";

function createServer(t: TestContext) {
  const server = new LCodeProtocolAgentServer({
    createLCodeApp: () => {
      throw new Error("This test must not create a runtime");
    },
  });
  const requests: LCodeProtocolRequest[] = [];
  const sink = (message: LCodeProtocolNotification | LCodeProtocolRequest) => {
    if ("id" in message) requests.push(message);
  };
  server.setNotificationSink(sink);
  t.after(async () => {
    await server.shutdown();
    server.disposeProjections();
  });
  return { server, requests, sink, context: server.officialMcpAuthRequestContext };
}

const identitySchema = { parse: (value: unknown) => value };

test("original protocol entrypoints retain every public callable arity", () => {
  const expected: Record<string, number> = {
    buildSessionSnapshot: 1,
    mapSessionSettings: 1,
    mapSessionInfo: 1,
    mapSessionEvent: 2,
    mapSessionEventForProtocol: 2,
    mapSessionEvents: 2,
    shouldExposeSessionEventToProtocol: 1,
    resolveSessionContextUsage: 1,
    listPlugins: 2,
    setPluginEnabled: 3,
    getPluginsOverview: 2,
    addPluginMarketplace: 3,
    removePluginMarketplace: 2,
    updatePluginMarketplace: 3,
    installPlugin: 3,
    uninstallPlugin: 2,
    updatePlugin: 2,
    restoreBuiltinPlugin: 2,
    configurePlugin: 2,
    resetPluginConfig: 2,
    validatePlugin: 2,
    describePlugin: 2,
    collectSubagentChildSessionIds: 3,
    projectSessionSubagents: 1,
    paginateEndedSubagents: 2,
    createProtocolInteractionBroker: 1,
    createConversationV4Gateway: 1,
  };
  const actual = {
    ...sessionMapper,
    ...plugins,
    ...subagentQuery,
    createProtocolInteractionBroker,
    createConversationV4Gateway,
  };
  assert.deepEqual(
    Object.fromEntries(Object.entries(actual).map(([name, fn]) => [name, fn.length])),
    expected,
  );
  const methods: Record<string, number> = {
    rebalanceResidentSessions: 0,
    pruneSessionEventStores: 0,
    pruneDetachedChildPublishers: 0,
    collectMemoryDiagnostics: 0,
    setNotificationSink: 1,
    disconnectClient: 1,
    shutdown: 0,
    disposeProjections: 0,
    takePostResponseMessages: 1,
    takePostResponseBatch: 1,
    clearPostResponseMessages: 0,
    handleMessage: 1,
  };
  for (const [name, arity] of Object.entries(methods)) {
    const method = Object.getOwnPropertyDescriptor(LCodeProtocolAgentServer.prototype, name)?.value;
    assert.equal(typeof method, "function", name);
    assert.equal(method.length, arity, name);
  }
});

test("reverse request aliases share one pending owner and retain trace until settlement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { server, requests, context } = createServer(t);
  const params = { requestId: "interaction-1", sessionId: "session-1" };
  const trace = { traceId: "trace-1", spanId: "span-1", parentId: "parent-1" };
  const response = context.requestClient(
    lcodeProtocolMethods.interactionRequestPermission,
    params,
    identitySchema,
    { reannounceIntervalMs: 10, timeoutMs: 100, trace },
  );
  t.mock.timers.tick(10);
  assert.deepEqual(
    requests.map((request) => request.id),
    ["server-1", "server-2"],
  );
  for (const request of requests) {
    assert.equal(request.params, params);
    assert.equal(request.trace, trace);
  }
  await server.handleMessage({ id: requests[0]!.id, result: { approved: true } });
  assert.deepEqual(await response, { approved: true });
  await server.handleMessage({ id: requests[1]!.id, result: { approved: false } });
  t.mock.timers.tick(1_000);
  assert.equal(requests.length, 2);
});

test("disconnect snapshots pending requests before a reentrant reconnect adds another request", async (t) => {
  const { server, requests, context, sink } = createServer(t);
  const controller = new AbortController();
  const removeListener = controller.signal.removeEventListener.bind(controller.signal);
  let afterReconnect: Promise<unknown> | undefined;
  t.mock.method(
    controller.signal,
    "removeEventListener",
    (...args: Parameters<typeof removeListener>) => {
      removeListener(...args);
      server.setNotificationSink(sink);
      afterReconnect = context.requestClient(
        lcodeProtocolMethods.interactionRequestPermission,
        { requestId: "new-request" },
        identitySchema,
      );
    },
  );
  const first = context.requestClient(
    lcodeProtocolMethods.interactionRequestPermission,
    { requestId: "first" },
    identitySchema,
    { signal: controller.signal },
  );
  const second = context.requestClient(
    lcodeProtocolMethods.interactionRequestPermission,
    { requestId: "second" },
    identitySchema,
  );
  const error = new Error("Connection closed");
  const rejected = [
    assert.rejects(first, (actual) => actual === error),
    assert.rejects(second, (actual) => actual === error),
  ];
  server.disconnectClient(error);
  await Promise.all(rejected);
  assert.ok(afterReconnect);
  await server.handleMessage({ id: requests[2]!.id, result: "new connection response" });
  assert.equal(await afterReconnect, "new connection response");
});

test("reverse cancellation and remote errors retain their original protocol error shape", async (t) => {
  const { server, requests, context } = createServer(t);
  const controller = new AbortController();
  const cancelled = context.requestClient(
    lcodeProtocolMethods.interactionRequestPermission,
    {},
    identitySchema,
    { signal: controller.signal },
  );
  const cancellation = assert.rejects(cancelled, { code: -32021 });
  controller.abort();
  await cancellation;
  const rejected = context.requestClient(
    lcodeProtocolMethods.interactionRequestPermission,
    {},
    identitySchema,
  );
  const failure = assert.rejects(rejected, {
    code: -32042,
    message: "Rejected",
    data: { reason: "guard" },
  });
  await server.handleMessage({
    id: requests[1]!.id,
    error: { code: -32042, message: "Rejected", data: { reason: "guard" } },
  });
  await failure;
});
