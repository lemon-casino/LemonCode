import assert from "node:assert/strict";
import test from "node:test";
import type { AuthDriver, AuthWireProtocol } from "@lcode/provider-node";
import { executeProviderAccountPool } from "./providerAccountPool.js";

const protocol = "openai-chat-completions" as const;
function fixture(run: (id: string, request: Request) => Promise<Response>) {
  const accounts = ["first", "second", "disabled", "other-protocol"].map((id) => ({
    connectionId: id,
    channelId: "fixture",
    enabled: id !== "disabled",
    models: [
      {
        id: "model",
        name: "Model",
        baseURL: "https://fixture.invalid/v1",
        protocol: (id === "other-protocol" ? "anthropic-messages" : protocol) as AuthWireProtocol,
      },
    ],
  }));
  const active = new Set<AbortController>();
  const calls: string[] = [];
  const host = {
    read: async () => accounts,
    driver: async (account: (typeof accounts)[number]): Promise<AuthDriver> => ({
      methods: async () => [],
      authorize: async () => {
        throw new Error("not used");
      },
      models: async () => account.models,
      fetch: async (request) => {
        calls.push(account.connectionId);
        return run(account.connectionId, request);
      },
    }),
    context: () => ({ read: async () => null, write: async () => {} }),
    track: () => {
      const controller = new AbortController();
      active.add(controller);
      return controller;
    },
    untrack: (_id: string, controller: AbortController) => {
      active.delete(controller);
    },
    preferred: new Map<string, string>(),
    withAccountLock: async <T>(_account: (typeof accounts)[number], operation: () => Promise<T>) =>
      operation(),
  };
  function request(session = "session", signal?: AbortSignal, modelId = "model") {
    return executeProviderAccountPool(
      host,
      "fixture",
      modelId,
      protocol,
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "x-lcode-session-id": session },
        body: JSON.stringify({ model: modelId }),
        signal,
      }),
    );
  }
  return { accounts, active, calls, request };
}

test("account preferences stay within each session and skip disabled or incompatible accounts", async () => {
  let limited = true;
  const pool = fixture(
    async (id) => new Response(id, { status: id === "first" && limited ? 429 : 200 }),
  );
  assert.equal(await (await pool.request("A")).text(), "second");
  limited = false;
  assert.equal(await (await pool.request("B")).text(), "first");
  assert.equal(await (await pool.request("A")).text(), "second");
  pool.accounts[1]!.models = [];
  assert.equal(await (await pool.request("A")).text(), "first");
  assert.deepEqual(pool.calls, ["first", "second", "first", "second", "first"]);
  assert.equal(pool.active.size, 0);
});

test("manually added model IDs use an authorized fixed endpoint without widening known model account access", async () => {
  const pool = fixture(async (id, request) => {
    assert.equal(request.url, "https://fixture.invalid/v1/chat/completions");
    const body = (await request.json()) as { model: string };
    assert.equal(body.model, "new-model");
    return new Response(id);
  });
  assert.equal(await (await pool.request("custom", undefined, "new-model")).text(), "first");
  assert.deepEqual(pool.calls, ["first"]);
});

test("exhausted accounts preserve the last upstream failure and actual account attribution", async () => {
  const pool = fixture(async (id) => new Response(id, { status: id === "first" ? 429 : 503 }));
  const response = await pool.request();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("x-zcode-connection-id"), "second");
  assert.equal(await response.text(), "second");
  assert.deepEqual(pool.calls, ["first", "second"]);
  assert.equal(pool.active.size, 0);
});

test("a stream failure after output never switches accounts or joins another answer", async () => {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const pool = fixture(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            output = controller;
            controller.enqueue(new TextEncoder().encode("first chunk"));
          },
        }),
      ),
  );
  const response = await pool.request();
  const reader = response.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "first chunk");
  output.error(new Error("upstream disconnected"));
  await assert.rejects(reader.read(), /upstream disconnected/u);
  assert.deepEqual(pool.calls, ["first"]);
  assert.equal(pool.active.size, 0);
});

test("cancelling the request aborts the active account without starting a fallback", async () => {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pool = fixture(
    async (_id, request) =>
      new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), {
          once: true,
        });
        entered();
      }),
  );
  const controller = new AbortController();
  const response = pool.request("session", controller.signal);
  await ready;
  controller.abort();
  await assert.rejects(response, { name: "AbortError" });
  assert.deepEqual(pool.calls, ["first"]);
  assert.equal(pool.active.size, 0);
});
