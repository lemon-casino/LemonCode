import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import {
  BROKER_CAPABILITY_ENV,
  BROKER_GENERATION_ENV,
  BROKER_SOCKET_ENV,
  mintBrokerSocketPath,
} from "@zcode/zcode-cua/broker";
import { captureComputerUseRuntimeFromEnvironment } from "./server.js";

test("trusted plugin authority outranks a stale legacy broker capability", async (t) => {
  const socketPath = mintBrokerSocketPath();
  let observedCapability: unknown;
  const server = createServer((socket) => {
    let pending = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      pending += chunk;
      const newline = pending.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(pending.slice(0, newline)) as {
        id: string;
        capability?: unknown;
      };
      observedCapability = request.capability;
      socket.end(
        `${JSON.stringify({
          id: request.id,
          ok: true,
          result: { content: [{ type: "text", text: "ok" }] },
        })}\n`,
      );
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, resolveListen);
  });
  t.after(
    () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      }),
  );

  const runtime = captureComputerUseRuntimeFromEnvironment({
    [BROKER_SOCKET_ENV]: socketPath,
    [BROKER_CAPABILITY_ENV]: "stale-capability",
    [BROKER_GENERATION_ENV]: "0",
    ZCODE_CUA_PLUGIN_AUTHORITY: "trusted-authority",
  });
  assert.ok(runtime);
  t.after(() => runtime.dispose());

  const result = await runtime.execute({
    toolName: "list_apps",
    arguments: {},
    context: {
      runtimeScope: "main",
      sessionId: "cua-env-test",
      workspaceKey: "cua-env-test",
    },
  });

  assert.deepEqual(result, { content: [{ type: "text", text: "ok" }] });
  assert.equal(observedCapability, "trusted-authority");
});
