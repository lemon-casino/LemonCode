import assert from "node:assert/strict";
import test from "node:test";
import { LCodeProtocolAgentServer } from "./server.js";
import { createProtocolCheckoutExecutionPort } from "./checkout-execution-port.js";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";
import type { LCodeApp } from "../app/types.js";
import type { LCodeProtocolRequest } from "@lcode/shared";

test("shutdown admits only owned cleanup and accepts its response before disconnect", async () => {
  let release!: () => Promise<void>;
  const server = new LCodeProtocolAgentServer({
    createLCodeApp: () =>
      ({
        sessionId: "parent",
        runtime: { beginShutdown() {}, stopActiveForegroundExecution() {} },
        close: () => release(),
      }) as unknown as LCodeApp,
  });
  const context = (server as unknown as { context: LCodeProtocolAgentServerContext }).context;
  const requests: LCodeProtocolRequest[] = [];
  server.setNotificationSink((message) => {
    if ("id" in message) requests.push(message);
  });
  await context.deps.createLCodeApp();
  const port = createProtocolCheckoutExecutionPort(context, {
    workspacePath: "C:/fixture",
    workspaceKey: "C:/fixture",
  });
  const acquiring = port.acquire({
    sessionId: "parent",
    turnId: "turn",
    signal: new AbortController().signal,
  });
  await server.handleMessage({ id: requests.at(-1)!.id, result: { permitId: "original-permit" } });
  release = (await acquiring).release;
  const closing = server.shutdown();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((requests.at(-1)!.params as { permitId: string }).permitId, "original-permit");
  await assert.rejects(
    server.handleMessage({ id: "new", method: "system/info", params: {} }),
    /stopping/,
  );
  assert.throws(
    () => context.requestClient("checkout/acquireWriter", {}, { parse: (v) => v }),
    /stopping/,
  );
  assert.throws(
    () =>
      context.requestClient(
        "checkout/acquireWriter",
        {},
        { parse: (v) => v },
        { purpose: "resource_cleanup" },
      ),
    /cleanup/,
  );
  await server.handleMessage({ id: requests.at(-1)!.id, result: { released: true } });
  await closing;
  assert.throws(
    () =>
      context.requestClient(
        "checkout/releaseWriter",
        { permitId: "original-permit", sessionId: "parent" },
        { parse: (v) => v },
        { purpose: "resource_cleanup" },
      ),
    /stopping/,
  );
  server.disposeProjections();
});
