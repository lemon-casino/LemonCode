import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PluginWorkerTransport } from "./transport.js";

test("confirmed worker and captured stdio cleanup lets its parent process exit naturally", async () => {
  const moduleUrl = new URL("./transport.ts", import.meta.url).href;
  const source = `import { Worker } from "node:worker_threads"; import { PluginWorkerTransport } from ${JSON.stringify(moduleUrl)};
    const worker = new Worker('const {parentPort}=require("node:worker_threads"); parentPort.on("message", m => {if(m.kind === "dispose") process.exit(0);});', { eval:true, stdout:true, stderr:true, execArgv:[] });
    const transport = new PluginWorkerTransport("fixture", undefined, undefined, undefined, undefined, { worker });
    await transport.dispose();
    process.stdout.write("closed-ready");`;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    { timeout: 4000, windowsHide: true },
  );
  assert.equal(stdout, "closed-ready");
});

test("driver close cancels pre-worker upload and waits for its physical cleanup", async () => {
  const worker = new Worker(
    'const {parentPort}=require("node:worker_threads"); parentPort.on("message", m => { if(m.kind === "dispose") process.exit(0); else throw new Error("unexpected call"); });',
    { eval: true, stdout: true, stderr: true },
  );
  await once(worker, "online");
  const transport = new PluginWorkerTransport(
    "fixture",
    undefined,
    undefined,
    undefined,
    undefined,
    { worker },
  );
  const reading = Promise.withResolvers<void>(),
    gate = Promise.withResolvers<void>();
  let cancels = 0,
    closed = false;
  const request = new Request("https://example.test", {
    method: "POST",
    duplex: "half",
    body: new ReadableStream<Uint8Array>(
      {
        pull() {
          reading.resolve();
        },
        cancel() {
          cancels++;
          return gate.promise;
        },
      },
      { highWaterMark: 0 },
    ),
  } as RequestInit);
  const fetching = assert.rejects(transport.fetch(request), { name: "AbortError" });
  await reading.promise;
  const closing = transport.dispose().then(() => {
    closed = true;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(cancels, 1);
    assert.equal(closed, false);
  } finally {
    gate.resolve();
    await Promise.all([fetching, closing]);
  }
});

for (const source of ["request", "context"] as const)
  test(`${source} cancellation stops upload before a worker call`, async () => {
    const worker = new Worker(
      'const {parentPort}=require("node:worker_threads"); parentPort.on("message", m => { if(m.kind === "dispose") process.exit(0); else throw new Error("unexpected call"); });',
      { eval: true, stdout: true, stderr: true },
    );
    await once(worker, "online");
    const transport = new PluginWorkerTransport(
      "fixture",
      undefined,
      undefined,
      undefined,
      undefined,
      { worker },
    );
    const reading = Promise.withResolvers<void>(),
      caller = new AbortController();
    let cancels = 0;
    const request = new Request("https://example.test", {
      method: "POST",
      duplex: "half",
      ...(source === "request" ? { signal: caller.signal } : {}),
      body: new ReadableStream<Uint8Array>(
        {
          pull() {
            reading.resolve();
          },
          cancel() {
            cancels++;
          },
        },
        { highWaterMark: 0 },
      ),
    } as RequestInit);
    try {
      const fetching = assert.rejects(
        transport.fetch(
          request,
          source === "context"
            ? { read: async () => null, write: async () => {}, signal: caller.signal }
            : undefined,
        ),
        { name: "AbortError" },
      );
      await reading.promise;
      caller.abort();
      await fetching;
      assert.equal(cancels, 1);
    } finally {
      await transport.dispose();
    }
  });

test("worker exit cannot acknowledge a still pending upload cancellation", async (t) => {
  const worker = new Worker(
    'const {parentPort}=require("node:worker_threads"); parentPort.on("message", m => {if(m.kind === "dispose") process.exit(0);});',
    { eval: true, stdout: true, stderr: true },
  );
  await once(worker, "online");
  const transport = new PluginWorkerTransport(
    "fixture",
    undefined,
    undefined,
    undefined,
    undefined,
    { worker },
  );
  const reading = Promise.withResolvers<void>(),
    gate = Promise.withResolvers<void>();
  const request = new Request("https://example.test", {
    method: "POST",
    duplex: "half",
    body: new ReadableStream<Uint8Array>(
      {
        pull() {
          reading.resolve();
        },
        cancel: () => gate.promise,
      },
      { highWaterMark: 0 },
    ),
  } as RequestInit);
  const fetching = assert.rejects(transport.fetch(request), { name: "AbortError" });
  await reading.promise;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const exited = once(worker, "exit");
    const rejected = assert.rejects(
      transport.dispose(),
      /upload cleanup remains pending after worker exit/,
    );
    await exited;
    t.mock.timers.tick(1000);
    await rejected;
    await fetching;
  } finally {
    gate.resolve();
    t.mock.timers.reset();
  }
});

test(
  "unresponsive owned worker is terminated within remaining budget and reports incomplete cleanup",
  { timeout: 3000 },
  async () => {
    const worker = new Worker("setInterval(() => {}, 1000)", {
      eval: true,
      stdout: true,
      stderr: true,
    });
    await once(worker, "online");
    let exits = 0;
    worker.on("exit", () => {
      exits++;
    });
    const transport = new PluginWorkerTransport(
      "fixture",
      undefined,
      undefined,
      undefined,
      undefined,
      { worker },
    );
    const closing = transport.dispose({ deadlineAt: Date.now() + 25 });
    await assert.rejects(closing, /forced termination/);
    await assert.rejects(transport.dispose(), /forced termination/);
    assert.equal(exits, 1);
  },
);
