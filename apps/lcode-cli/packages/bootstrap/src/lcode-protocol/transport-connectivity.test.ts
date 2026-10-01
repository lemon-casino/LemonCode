import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  lcodeProtocolMethods,
  type LCodeProtocolMessage,
  type LCodeProtocolRequest,
} from "@lcode/shared";
import type { LCodeApp } from "../app/types.js";
import { LCodeProtocolAgentServer } from "./server.js";
import { LCodeProtocolNdjsonConnection } from "./transport.js";

type Handler = ConstructorParameters<typeof LCodeProtocolNdjsonConnection>[0]["handleMessage"];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const probe = (id: string): LCodeProtocolRequest => ({
  id,
  method: lcodeProtocolMethods.providerTestModelConnectivity,
  params: {},
});
const config = (id: string): LCodeProtocolRequest => ({
  id,
  method: lcodeProtocolMethods.providerUpdateAccountConfig,
  params: {},
});
function harness(handleMessage: Handler) {
  const input = new PassThrough();
  const output = new PassThrough();
  const abort = new AbortController();
  const responses: LCodeProtocolMessage[] = [];
  let outputBuffer = "";
  output.on("data", (chunk: Buffer) => {
    outputBuffer += chunk.toString();
    let newline: number;
    while ((newline = outputBuffer.indexOf("\n")) >= 0) {
      responses.push(JSON.parse(outputBuffer.slice(0, newline)) as LCodeProtocolMessage);
      outputBuffer = outputBuffer.slice(newline + 1);
    }
  });
  const connection = new LCodeProtocolNdjsonConnection({
    input,
    output,
    signal: abort.signal,
    handleMessage,
  });
  connection.start();
  return {
    input,
    connection,
    responses,
    send: (...messages: LCodeProtocolMessage[]) =>
      input.write(messages.map((message) => JSON.stringify(message)).join("\n") + "\n"),
    close: async () => {
      abort.abort();
      await connection.waitForClose();
      input.destroy();
      output.destroy();
    },
  };
}

test("real NDJSON probes overlap behind their captured configuration barrier without blocking later writes", async () => {
  const firstConfig = deferred();
  const laterConfig = deferred();
  const probes = deferred();
  const order: string[] = [];
  const h = harness(async (message) => {
    if (!("method" in message) || !("id" in message)) return;
    order.push(String(message.id));
    if (message.id === "config-before") await firstConfig.promise;
    if (message.id === "config-later") await laterConfig.promise;
    if (message.method === lcodeProtocolMethods.providerTestModelConnectivity) await probes.promise;
    return { id: message.id, result: { success: true } };
  });
  try {
    h.send(
      config("config-before"),
      probe("probe-1"),
      probe("probe-2"),
      probe("probe-3"),
      probe("probe-4"),
      config("config-later"),
      probe("probe-5"),
    );
    await tick();
    assert.deepEqual(order, ["config-before"]);
    firstConfig.resolve();
    await tick();
    assert.deepEqual(order, [
      "config-before",
      "probe-1",
      "probe-2",
      "probe-3",
      "probe-4",
      "config-later",
    ]);
    laterConfig.resolve();
    await tick();
    assert.equal(order.at(-1), "probe-5");
    assert.equal(
      h.responses.filter((response) => "id" in response && String(response.id).startsWith("probe-"))
        .length,
      0,
    );
    probes.resolve();
    await tick();
    assert.equal(h.responses.length, 7);
  } finally {
    firstConfig.resolve();
    laterConfig.resolve();
    probes.resolve();
    await h.close();
  }
});

test("probe error and cancellation responses do not poison ordinary request processing", async () => {
  const blocked = deferred();
  const order: string[] = [];
  const h = harness(async (message) => {
    if (!("method" in message) || !("id" in message)) return;
    order.push(String(message.id));
    if (message.method === lcodeProtocolMethods.providerTestModelConnectivity) {
      await blocked.promise;
      return {
        id: message.id,
        error: { code: -32000, message: message.id === "failed" ? "probe failure" : "AbortError" },
      };
    }
    return { id: message.id, result: {} };
  });
  try {
    h.send(probe("failed"), probe("cancelled"), config("ordinary"));
    await tick();
    assert.deepEqual(order, ["failed", "cancelled", "ordinary"]);
    assert.equal(h.responses.length, 1);
    blocked.resolve();
    await tick();
    h.send(config("after"));
    await tick();
    assert.equal(h.responses.length, 4);
    assert.equal(h.responses.filter((message) => "error" in message).length, 2);
  } finally {
    blocked.resolve();
    await h.close();
  }
});

test("real server normalizes thrown and aborted probes while ordinary NDJSON requests keep progressing", async () => {
  const entered = deferred();
  const release = deferred();
  const params = {
    workspace: { workspacePath: "/workspace", workspaceKey: "/workspace" },
    selection: { providerId: "custom", modelId: "probe" },
    mode: "temporary",
  };
  let probes = 0;
  let closedApps = 0;
  const server = new LCodeProtocolAgentServer({
    createLCodeApp: () =>
      ({
        testModelConnectivity: async () => {
          probes += 1;
          const index = probes;
          if (probes === 2) entered.resolve();
          await release.promise;
          if (index === 1) throw new Error("model execution failed");
          throw new DOMException("model execution cancelled", "AbortError");
        },
        runtime: { beginShutdown: () => undefined },
        close: async () => {
          closedApps += 1;
        },
      }) as unknown as LCodeApp,
  });
  const h = harness((message) => server.handleMessage(message));
  try {
    h.send(
      { ...probe("failure"), params },
      { ...probe("abort"), params },
      {
        id: "ordinary",
        method: lcodeProtocolMethods.runtimeCapabilities,
        params: {},
      },
    );
    await entered.promise;
    await tick();
    assert.deepEqual(
      h.responses.map((message) => ("id" in message ? message.id : undefined)),
      ["ordinary"],
    );
    release.resolve();
    await tick();
    assert.equal(h.responses.filter((message) => "error" in message).length, 0);
    for (const id of ["failure", "abort"]) {
      const response = h.responses.find((message) => "id" in message && message.id === id);
      assert.ok(response && "result" in response);
      assert.deepEqual(response.result, {
        success: false,
        error: {
          message: id === "failure" ? "model execution failed" : "model execution cancelled",
        },
      });
    }
    assert.equal(closedApps, 2);
    h.send({ id: "after", method: lcodeProtocolMethods.runtimeCapabilities, params: {} });
    await tick();
    assert.equal(h.responses.length, 4);
  } finally {
    release.resolve();
    await h.close();
    await server.shutdown();
  }
});

test("reverse responses and stop/cancel bypass still unblock a long ordinary handler", async () => {
  const requestStarted = deferred();
  const controls = deferred();
  let controlCount = 0;
  const order: string[] = [];
  const h = harness(async (message) => {
    if (!("method" in message)) {
      order.push("reverse-response");
      return;
    }
    if (!("id" in message)) return;
    order.push(String(message.id));
    if (message.id === "long-request") {
      requestStarted.resolve();
      await controls.promise;
    }
    if (
      message.method === lcodeProtocolMethods.sessionStop ||
      message.method === lcodeProtocolMethods.workspaceCancelGenerateText
    ) {
      controlCount += 1;
      if (controlCount === 2) controls.resolve();
    }
    return { id: message.id, result: {} };
  });
  try {
    h.send({ id: "long-request", method: lcodeProtocolMethods.workspaceGenerateText, params: {} });
    await requestStarted.promise;
    h.send(
      { id: "reverse", result: {} },
      { id: "stop", method: lcodeProtocolMethods.sessionStop, params: {} },
      { id: "cancel", method: lcodeProtocolMethods.workspaceCancelGenerateText, params: {} },
      probe("probe"),
      config("following"),
    );
    await tick();
    assert.deepEqual(order, [
      "long-request",
      "reverse-response",
      "stop",
      "cancel",
      "probe",
      "following",
    ]);
  } finally {
    controls.resolve();
    await h.close();
  }
});

test("EOF drains independent probes including a trailing NDJSON line before closing", async () => {
  const pending = deferred();
  const entered = deferred();
  const h = harness(async (message) => {
    if (!("id" in message)) return;
    entered.resolve();
    await pending.promise;
    return { id: message.id, result: { success: true } };
  });
  try {
    h.input.end(JSON.stringify(probe("last-probe")));
    await entered.promise;
    let closed = false;
    void h.connection.waitForClose().then(() => {
      closed = true;
    });
    await tick();
    assert.equal(closed, false);
    pending.resolve();
    await h.connection.waitForClose();
    assert.deepEqual(h.responses, [{ id: "last-probe", result: { success: true } }]);
  } finally {
    pending.resolve();
    await h.close();
  }
});

test("EOF deadline and abort do not wait forever for an independent probe or emit late responses", async () => {
  for (const closeKind of ["eof", "abort"] as const) {
    const pending = deferred();
    const entered = deferred();
    const h = harness(async (message) => {
      if (!("id" in message)) return;
      entered.resolve();
      await pending.promise;
      return { id: message.id, result: { success: true } };
    });
    try {
      h.send(probe("pending"));
      await entered.promise;
      if (closeKind === "eof") {
        h.input.end();
        await h.connection.waitForClose();
      } else await h.close();
      pending.resolve();
      await tick();
      assert.deepEqual(h.responses, []);
    } finally {
      pending.resolve();
      await h.close();
    }
  }
});
