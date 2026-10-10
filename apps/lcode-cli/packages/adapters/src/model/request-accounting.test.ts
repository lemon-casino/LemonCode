import assert from "node:assert/strict";
import test from "node:test";
import { createPhysicalRequestAccounting, type ModelNetworkStatusEvent } from "@lcode/contracts";
import { runGenerateText } from "./runner-generate.js";
import { runStreamText } from "./runner-stream.js";
import type { AiSdkModelRuntime, ResolvedAiSdkModel } from "./runner-runtime.js";

const resolved = {
  model: {},
  modelId: "fixture",
  providerId: "fixture",
  providerKind: "openai-compatible",
  properties: {
    contextWindow: 100,
    inputFormat: { text: true },
    outputFormat: { text: true },
    supportsToolCall: true,
  },
} as unknown as ResolvedAiSdkModel;

for (const transport of ["generate", "stream"] as const) {
  for (const cancelAt of ["started", "retry-yield"] as const) {
    test(`${transport} ${cancelAt} before provider invocation does not consume physical budget`, async () => {
      let sent = 0,
        evaluations = 0;
      const controller = new AbortController();
      const accounting = createPhysicalRequestAccounting({
        maxRequests: 3,
        maxReservedTokens: 360,
      });
      const runtime = {
        generateText() {
          sent++;
          throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
        },
        streamText() {
          sent++;
          throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
        },
      } as unknown as AiSdkModelRuntime;
      const input = {
        env: { LCODE_RUNTIME_ENV: "test" },
        modelIoFullRetentionEnabled: false,
        request: {
          messages: [{ role: "user" as const, content: "synthetic" }],
          maxOutputTokens: 20,
          abortSignal: controller.signal,
          statusSink: {
            publish(event: ModelNetworkStatusEvent) {
              if (cancelAt === "started" && event.type === "model_request_started")
                controller.abort();
            },
          },
          ...(cancelAt === "retry-yield"
            ? { shouldYieldRetryToFailover: () => ++evaluations === 2 }
            : {}),
        },
        resolveModel: () => resolved,
        resolved,
        runtime,
        retry: { backoffFactor: 1, baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
        statusSink: accounting,
        physicalRequestAccounting: accounting,
        streamIdleTimeoutMs: 1000,
      };
      await assert.rejects(async () => {
        if (transport === "generate") await runGenerateText(input);
        else
          for await (const _event of runStreamText(input)) {
            /* consume boundary */
          }
      });
      const expected = cancelAt === "started" ? 0 : 1;
      assert.equal(sent, expected);
      assert.equal(accounting.snapshot().requests.length, expected);
      assert.equal(accounting.snapshot().reservedTokens, expected * 120);
    });
  }
  test(`${transport} blocks provider invocation when physical budget cannot reserve`, async () => {
    let sent = 0;
    const controller = new AbortController();
    const accounting = createPhysicalRequestAccounting(
      { maxRequests: 1, maxReservedTokens: 110 },
      () => controller.abort(),
    );
    const runtime = {
      generateText() {
        sent++;
        throw new Error("must not send");
      },
      streamText() {
        sent++;
        throw new Error("must not send");
      },
    } as unknown as AiSdkModelRuntime;
    const input = {
      env: { LCODE_RUNTIME_ENV: "test" },
      modelIoFullRetentionEnabled: false,
      request: {
        messages: [{ role: "user" as const, content: "synthetic" }],
        maxOutputTokens: 20,
        abortSignal: controller.signal,
      },
      resolveModel: () => resolved,
      resolved,
      runtime,
      retry: { backoffFactor: 1, baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      statusSink: accounting,
      physicalRequestAccounting: accounting,
      streamIdleTimeoutMs: 1000,
    };
    await assert.rejects(async () => {
      if (transport === "generate") await runGenerateText(input);
      else
        for await (const _event of runStreamText(input)) {
          /* consume cancellation */
        }
    });
    assert.equal(sent, 0);
    assert.equal(accounting.snapshot().reservedTokens, 0);
  });
}

for (const transport of ["generate", "stream-throw", "stream-chunk"] as const) {
  for (const benchmark of [true, false]) {
    test(`${transport} off-peak queued keeps logical attempt but ${benchmark ? "reserves each physical request" : "uses fresh physical IDs without consuming retries"}`, async () => {
      let sent = 0;
      const controller = new AbortController();
      const limits: string[] = [];
      const events: ModelNetworkStatusEvent[] = [];
      const accounting = benchmark
        ? createPhysicalRequestAccounting({ maxRequests: 1, maxReservedTokens: 240 }, (reason) => {
            limits.push(reason);
            controller.abort(new Error(reason));
          })
        : undefined;
      const offPeakResolved = {
        ...resolved,
        accountAccess: { mode: "off-peak", type: "zhipu-account" },
      } as unknown as ResolvedAiSdkModel;
      const queueFailure = Object.assign(new Error("queued"), {
        responseHeaders: { "retry-after-ms": "0" },
        statusCode: 429,
      });
      const finalFailure = new Error("synthetic terminal failure");
      const runtime = {
        async generateText() {
          sent++;
          throw sent === 1 ? queueFailure : finalFailure;
        },
        streamText() {
          sent++;
          if (sent > 1) throw finalFailure;
          if (transport === "stream-throw") throw queueFailure;
          return {
            fullStream: {
              async *[Symbol.asyncIterator]() {
                yield { type: "error", error: queueFailure };
              },
            },
          };
        },
      } as unknown as AiSdkModelRuntime;
      const input = {
        env: { LCODE_RUNTIME_ENV: "test" },
        modelIoFullRetentionEnabled: false,
        request: {
          messages: [{ role: "user" as const, content: "synthetic off-peak request" }],
          maxOutputTokens: 20,
          selectedSpeed: null,
          abortSignal: controller.signal,
          statusSink: {
            publish: (event: ModelNetworkStatusEvent) => {
              events.push(event);
            },
          },
        },
        resolveModel: () => offPeakResolved,
        resolved: offPeakResolved,
        runtime,
        // 排队仍不消耗这一个逻辑重试机会；第二次真实调用仅受 benchmark 限制。
        retry: { backoffFactor: 1, baseDelayMs: 0, jitter: false, maxAttempts: 1, maxDelayMs: 0 },
        statusSink: accounting,
        physicalRequestAccounting: accounting,
        streamIdleTimeoutMs: 1000,
      };
      await assert.rejects(async () => {
        if (transport === "generate") await runGenerateText(input);
        else
          for await (const _event of runStreamText(input)) {
            /* consume retry boundary */
          }
      });
      const starts = events.filter((event) => event.type === "model_request_started");
      assert.equal(sent, benchmark ? 1 : 2);
      assert.deepEqual(
        starts.map((event) => event.attempt),
        [1, 1],
      );
      if (accounting) {
        assert.deepEqual(limits, ["benchmark_request_budget"]);
        assert.equal(accounting.snapshot().reservedTokens, 120);
        assert.equal(accounting.snapshot().requests.length, 1);
        assert.equal(accounting.snapshot().requests[0]?.status, "failed");
        assert.equal(accounting.snapshot().requests[0]?.selectedSpeed, null);
      } else {
        assert.notEqual(starts[0]?.requestId, starts[1]?.requestId);
        assert.equal(events.filter((event) => event.type === "model_request_failed").length, 2);
      }
    });
  }
}
