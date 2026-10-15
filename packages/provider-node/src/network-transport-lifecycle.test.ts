import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import type { Dispatcher } from "undici";
import { createHostApiNetworkTransport } from "./network-transport.js";

test("network close rejects real dispatcher failures and retries only unfinished cleanup", async () => {
  let closes = 0;
  const transport = createHostApiNetworkTransport(async () => ({}), {
    fetch: async () => new Response("fixture"),
    createDispatcher: async () =>
      ({
        close: async () => {
          if (++closes === 1) throw new Error("fixture close failure");
        },
      }) as unknown as Dispatcher,
  });
  await (await transport.fetch("https://example.test")).text();
  await assert.rejects(transport.disposeAndWait(), /fixture close failure/);
  await assert.rejects(transport.fetch("https://example.test"), /disposed/);
  await transport.disposeAndWait();
  await transport.disposeAndWait();
  assert.equal(closes, 2);
});

test("cancelled body retains its actual cleanup until owner close has drained it", async () => {
  let release!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  const transport = createHostApiNetworkTransport(async () => ({}), {
    fetch: async () => new Response(new ReadableStream({ cancel: () => cleanup })),
    createDispatcher: async () =>
      ({ close: async () => {}, destroy: async () => {} }) as unknown as Dispatcher,
  });
  await transport.fetch("https://example.test", { signal: controller.signal });
  controller.abort();
  assert.equal(transport.activeRequestCount, 0);
  let closed = false;
  const closing = transport.disposeAndWait().then(() => {
    closed = true;
  });
  await setImmediate();
  try {
    assert.equal(closed, false);
  } finally {
    release();
    await closing;
  }
});

test("changed routes keep at most 32 idle dispatchers and close every owned dispatcher once", async () => {
  let version = 0,
    created = 0;
  const closes = new Map<number, number>();
  const transport = createHostApiNetworkTransport(async () => ({ caCertPath: String(version) }), {
    fetch: async () => new Response("fixture"),
    createDispatcher: async () => {
      const id = ++created;
      const close = async () => {
        closes.set(id, (closes.get(id) ?? 0) + 1);
      };
      return { close, destroy: close } as unknown as Dispatcher;
    },
  });
  for (version = 0; version < 45; version++)
    await (await transport.fetch("https://example.test")).text();
  await setImmediate();
  assert.equal(created - closes.size, 32);
  version = 0;
  await (await transport.fetch("https://example.test")).text();
  assert.equal(created, 46);
  await transport.disposeAndWait();
  assert.equal(closes.size, created);
  assert.equal(
    [...closes.values()].every((count) => count === 1),
    true,
  );
});

test("independent owners share no shutdown authority", async (t) => {
  const server = createServer((_request, response) => response.end("fixture"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const first = createHostApiNetworkTransport(async () => ({}));
  const second = createHostApiNetworkTransport(async () => ({}));
  t.after(() => {
    first.dispose();
    second.dispose();
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${address.port}`;
  await (await first.fetch(url)).text();
  await (await second.fetch(url)).text();
  await first.disposeAndWait();
  assert.equal(await (await second.fetch(url)).text(), "fixture");
  await second.disposeAndWait();
});

test("sequential POSTs reuse connections and owner shutdown rejects new requests", async (t) => {
  let connections = 0;
  const server = createServer((request, response) => {
    request.resume();
    response.end("fixture");
  });
  server.on("connection", () => connections++);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const transport = createHostApiNetworkTransport(async () => ({ forceDirect: true }));
  t.after(() => {
    transport.dispose();
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${address.port}`;
  for (let i = 0; i < 5; i++) {
    assert.equal(
      await (await transport.fetch(url, { method: "POST", body: "{}" })).text(),
      "fixture",
    );
    await setImmediate();
  }
  assert.equal(connections, 1);
  const closing = transport.disposeAndWait();
  assert.equal(transport.disposeAndWait(), closing);
  await closing;
  await assert.rejects(transport.fetch(url), /disposed/i);
});

test("terminal fetch injection still receives direct requests and cannot bypass invalid proxy validation", async () => {
  let calls = 0;
  let options = { forceDirect: true, httpProxy: undefined as string | undefined };
  const transport = createHostApiNetworkTransport(async () => options, {
    fetch: async (input, init) => {
      calls++;
      assert.equal(new Request(input, init).headers.get("x-fixture"), "retained");
      return new Response("injected");
    },
  });
  try {
    assert.equal(
      await (
        await transport.fetch("https://example.test", { headers: { "x-fixture": "retained" } })
      ).text(),
      "injected",
    );
    options = { forceDirect: true, httpProxy: "invalid://fixture" };
    await assert.rejects(transport.fetch("https://example.test"), /invalid/i);
    assert.equal(calls, 1);
  } finally {
    await transport.disposeAndWait();
  }
});

test("pre-aborted requests do not resolve policy or construct a dispatcher", async () => {
  let resolved = 0;
  const transport = createHostApiNetworkTransport(async () => {
    resolved++;
    return { forceDirect: true };
  });
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(transport.fetch("https://example.test", { signal: controller.signal }), {
      name: "AbortError",
    });
    assert.equal(resolved, 0);
  } finally {
    await transport.disposeAndWait();
  }
});

test(
  "shutdown aborts unconsumed SSE bodies and does not wait for their natural EOF",
  { timeout: 2_000 },
  async (t) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: fixture\n\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const transport = createHostApiNetworkTransport(async () => ({ forceDirect: true }));
    t.after(() => {
      transport.dispose();
      server.closeAllConnections();
      server.close();
    });
    const response = await transport.fetch(`http://127.0.0.1:${address.port}`);
    await transport.disposeAndWait();
    await assert.rejects(response.text());
  },
);

test("dispose waits for late dispatcher creation and destroys it exactly once", async () => {
  let release!: (dispatcher: Dispatcher) => void;
  let entered!: () => void;
  const created = new Promise<Dispatcher>((resolve) => {
    release = resolve;
  });
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let destroyed = 0;
  const dispatcher = {
    destroy: async () => {
      destroyed++;
    },
    close: async () => {
      destroyed++;
    },
  } as unknown as Dispatcher;
  const transport = createHostApiNetworkTransport(async () => ({ forceDirect: true }), {
    createDispatcher: async () => {
      entered();
      return created;
    },
  });
  const fetching = transport.fetch("https://example.test");
  const rejected = assert.rejects(fetching, /disposed/i);
  await entering;
  transport.dispose();
  const closing = transport.disposeAndWait();
  release(dispatcher);
  await Promise.all([closing, rejected]);
  assert.equal(destroyed, 1);
});

for (const kind of ["url", "request"] as const)
  test(`caller abort survives GC of ${kind} inputs until the SSE body ends`, async (t) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: fixture\n\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const transport = createHostApiNetworkTransport(async () => ({})),
      caller = new AbortController();
    t.after(async () => {
      transport.dispose();
      server.closeAllConnections();
      server.close();
      await transport.disposeAndWait();
    });
    const url = `http://127.0.0.1:${address.port}`;
    const response =
      kind === "url"
        ? await transport.fetch(url, { signal: caller.signal })
        : await transport.fetch(new Request(url, { signal: caller.signal }));
    for (let turn = 0; turn < 2; turn++) {
      await setImmediate();
      global.gc?.();
    }
    caller.abort();
    assert.equal(transport.activeRequestCount, 0);
    await assert.rejects(response.text(), { name: "AbortError" });
  });
