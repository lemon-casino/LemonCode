import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import { ClaudeRoutingRelay } from "./claude-routing-relay.js";
const deferred = <T>() => Promise.withResolvers<T>();
test(
  "PC-05 CLI output EOF and continuation both await physical relay EOF",
  { timeout: 10000 },
  async (t) => {
    let posts = 0;
    const entered = deferred<void>(),
      end = deferred<void>();
    const relay = new ClaudeRoutingRelay(async () => {
      posts++;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first"));
            entered.resolve();
            void end.promise.then(() => controller.close());
          },
        }),
      );
    });
    t.after(() => relay.dispose());
    const base = await relay.start(new AbortController().signal);
    const physical = fetch(base + "/v1/messages", { method: "POST", body: "{}" });
    await entered.promise;
    const upstream = await physical;
    let outputEnded = false,
      continued = false;
    const output = await relay.response(Promise.resolve(new Response("output")));
    const consumed = output.text().then((value) => {
      outputEnded = true;
      return value;
    });
    const next = relay.begin(new AbortController().signal).then(() => {
      continued = true;
    });
    try {
      await immediate();
      assert.equal(outputEnded, false);
      assert.equal(continued, false);
    } finally {
      end.resolve();
    }
    assert.equal(await upstream.text(), "first");
    assert.equal(await consumed, "output");
    await next;
    const second = await fetch(base + "/v1/messages", { method: "POST", body: "{}" });
    await second.text();
    assert.equal(posts, 2);
  },
);
test(
  "PC-05 relay rejects unknown paths and auxiliary tokens do not reset model permission",
  { timeout: 10000 },
  async (t) => {
    const paths: string[] = [];
    const relay = new ClaudeRoutingRelay(async (input) => {
      paths.push(String(input));
      return new Response("ok");
    });
    t.after(() => relay.dispose());
    const base = await relay.start(new AbortController().signal);
    for (const path of [
      "/v1/messages/count_tokens",
      "/v1/messages",
      "/v1/messages/count_tokens",
      "/unknown",
      "/v1/messages",
    ]) {
      const response = await fetch(base + path, { method: "POST", body: "{}" });
      await response.text();
    }
    assert.equal(paths.filter((p) => p.endsWith("/v1/messages")).length, 1);
    assert.equal(paths.length, 3);
  },
);
test("PC-05 consumer cancellation awaits upstream cancellation", { timeout: 10000 }, async (t) => {
  const ended = deferred<void>(),
    entered = deferred<void>();
  let cancelled = false;
  const relay = new ClaudeRoutingRelay(async (_input, init) => {
    init?.signal?.addEventListener(
      "abort",
      () => {
        cancelled = true;
        ended.resolve();
      },
      { once: true },
    );
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          entered.resolve();
        },
        async cancel() {
          await ended.promise;
        },
      }),
    );
  });
  t.after(() => relay.dispose());
  const base = await relay.start(new AbortController().signal);
  const physical = fetch(base + "/v1/messages", { method: "POST", body: "{}" });
  await entered.promise;
  const response = await relay.response(Promise.resolve(new Response("output")));
  const upstream = await physical;
  // 取消关闭真实 HTTP 响应，原客户端应观察到流中断；不能把该中断当作测试清理失败。
  const physicalEnd = assert.rejects(upstream.text(), /terminated|aborted/iu);
  await response.body!.cancel();
  assert.equal(cancelled, true);
  await physicalEnd;
});
