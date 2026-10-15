import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import type { Dispatcher } from "undici";
import { createHostApiNetworkTransport } from "./network-transport.js";

for (const kind of ["caller", "owner"] as const)
  test(`${kind} cancellation stops an unfinished upload and retains physical cancel`, async () => {
    const reading = Promise.withResolvers<void>(),
      cleanup = Promise.withResolvers<void>();
    const caller = new AbortController();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    let cancels = 0,
      sends = 0,
      settled = false,
      closed = false;
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          source = controller;
        },
        pull() {
          reading.resolve();
        },
        cancel() {
          cancels++;
          return cleanup.promise;
        },
      },
      { highWaterMark: 0 },
    );
    const transport = createHostApiNetworkTransport(async () => ({}), {
      createDispatcher: async () =>
        ({ close: async () => {}, destroy: async () => {} }) as unknown as Dispatcher,
      fetch: async () => {
        sends++;
        return new Response("unexpected");
      },
    });
    const request = new Request("https://example.test", {
      method: "POST",
      body,
      signal: caller.signal,
      duplex: "half",
    } as RequestInit);
    const fetching = transport.fetch(request).then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        assert.equal((error as Error).name, "AbortError");
      },
    );
    await reading.promise;
    await setImmediate();
    if (kind === "caller") caller.abort();
    else transport.dispose();
    const closing = transport.disposeAndWait().then(() => {
      closed = true;
    });
    try {
      await setImmediate();
      assert.equal(settled, true, "business wait must end before physical cancel settles");
      assert.equal(cancels, 1, "cancel the original upload reader");
      assert.equal(closed, false, "physical cancel remains owned");
      assert.equal(sends, 0);
      assert.equal(transport.activeRequestCount, 0);
    } finally {
      cleanup.resolve();
      if (!cancels) source.close();
      await Promise.all([fetching, closing]);
    }
  });

test("ordinary upload bytes are unchanged and EOF releases the reader", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0, 1]));
      controller.enqueue(new Uint8Array([254, 255]));
      controller.close();
    },
  });
  const transport = createHostApiNetworkTransport(async () => ({}), {
    fetch: async (input) => {
      assert.deepEqual(
        new Uint8Array(await (input as Request).arrayBuffer()),
        new Uint8Array([0, 1, 254, 255]),
      );
      return new Response("ok");
    },
  });
  try {
    const request = new Request("https://example.test", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);
    assert.equal(await (await transport.fetch(request)).text(), "ok");
  } finally {
    await transport.disposeAndWait();
  }
});

test("upload physical cancel failure remains visible after business cancellation", async () => {
  const reading = Promise.withResolvers<void>(),
    caller = new AbortController();
  const transport = createHostApiNetworkTransport(async () => ({}), {
    fetch: async () => new Response("unexpected"),
  });
  const fetching = transport.fetch("https://example.test", {
    method: "POST",
    signal: caller.signal,
    duplex: "half",
    body: new ReadableStream<Uint8Array>(
      {
        pull() {
          reading.resolve();
        },
        cancel() {
          throw new Error("fixture upload cancel failure");
        },
      },
      { highWaterMark: 0 },
    ),
  } as RequestInit);
  const rejected = assert.rejects(fetching, { name: "AbortError" });
  await reading.promise;
  caller.abort();
  await rejected;
  await assert.rejects(transport.disposeAndWait(), /fixture upload cancel failure/);
});

test("Request metadata and replacement body survive explicit reader ownership", async () => {
  const transport = createHostApiNetworkTransport(async () => ({}), {
    fetch: async (input) => {
      const request = input as Request;
      assert.equal(request.method, "PUT");
      assert.equal(request.headers.get("x-fixture"), "override");
      assert.equal(request.redirect, "manual");
      assert.equal(await request.text(), "replacement");
      return new Response("ok");
    },
  });
  try {
    const request = new Request("https://example.test", {
      method: "POST",
      body: "original",
      redirect: "manual",
    });
    await (
      await transport.fetch(request, {
        method: "PUT",
        body: "replacement",
        headers: { "x-fixture": "override" },
      })
    ).text();
    assert.equal(request.bodyUsed, false);
    await request.body?.cancel();
  } finally {
    await transport.disposeAndWait();
  }
});

test("invalid upload chunks fail before sending and cancel the original source", async () => {
  let cancels = 0,
    sends = 0;
  const transport = createHostApiNetworkTransport(async () => ({}), {
    fetch: async () => {
      sends++;
      return new Response("unexpected");
    },
  });
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue("invalid");
    },
    cancel() {
      cancels++;
    },
  });
  await assert.rejects(
    transport.fetch("https://example.test", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit),
    /Uint8Array/,
  );
  await transport.disposeAndWait();
  assert.equal(cancels, 1);
  assert.equal(sends, 0);
});
