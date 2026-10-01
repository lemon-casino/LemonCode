import assert from "node:assert/strict";
import test from "node:test";
import {
  createRootTraceContext,
  getCurrentModelInvocationContext,
  ModelRetryBudget,
  type Model,
  type ModelInvocationContext,
  type ModelOptions,
  type ModelRequest,
  type ModelStreamEvent,
} from "@lcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { testModelConnectivity } from "./workspace-generate-text.js";

function harness(outcome: "finish" | "error" | "unfinished" | "abort" = "finish") {
  const bindings: ModelOptions[] = [];
  const requests: ModelRequest[] = [];
  let invocation: ModelInvocationContext | undefined;
  const model = {
    providerId: "custom",
    modelId: "unregistered",
    properties: {},
    optionSpecs: {
      reasoningLevel: { values: ["low", "high"] },
      maxOutputTokens: { max: 1024 },
      speed: { values: ["normal", "fast"] },
    },
    options: { reasoningLevel: "high", speed: "fast" },
    bind: (options: ModelOptions) => {
      bindings.push(options);
      return model;
    },
    streamText: (request: ModelRequest) => {
      requests.push(request);
      invocation = getCurrentModelInvocationContext();
      return (async function* (): AsyncIterable<ModelStreamEvent> {
        if (outcome === "abort") request.abortSignal?.throwIfAborted();
        if (outcome === "error") throw new Error("model stream failed");
        if (outcome === "finish") {
          yield {
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        }
      })();
    },
  } as unknown as Model;
  let ordinaryCalls = 0;
  const modelFactory = () => {
    ordinaryCalls += 1;
    throw new Error("strict shared factory");
  };
  const admission = {
    acquire: async () => ({ publish: () => undefined, release: () => undefined }),
  };
  const runtime = {
    config: {},
    modelFactory,
    modelRequestAdmission: admission,
    rootTraceContext: createRootTraceContext(),
    createModelStatusSink: () => undefined,
  } as unknown as AgentRuntimeInternal;
  return {
    runtime,
    model,
    bindings,
    requests,
    admission,
    modelFactory,
    invocation: () => invocation,
    ordinaryCalls: () => ordinaryCalls,
  };
}

test("temporary connectivity uses an invocation-local raw factory and keeps runtime admission and minimal probe", async () => {
  const h = harness();
  await testModelConnectivity.call(
    h.runtime,
    {
      selection: { providerId: "custom", modelId: "unregistered" },
    },
    { rawModelFactory: () => h.model },
  );
  assert.equal(h.ordinaryCalls(), 0);
  assert.equal(h.runtime.modelFactory, h.modelFactory);
  assert.deepEqual(h.bindings, [{ reasoningLevel: "low", speed: "normal", maxOutputTokens: 1 }]);
  assert.deepEqual(h.requests[0]?.messages, [
    { role: "system", content: "You are LCode connectivity probe." },
    { role: "user", content: "hi" },
  ]);
  assert.equal(h.requests[0]?.tools, undefined);
  assert.equal(h.invocation()?.modelRequestAdmission, h.admission);
  assert.equal(h.invocation()?.modelRetryBudget, ModelRetryBudget.Default);
  assert.equal(h.invocation()?.modelRequestSessionType, "other");
  assert.equal(h.invocation()?.traceContext?.traceId, h.runtime.rootTraceContext.traceId);
});

test("caller cancellation does not remove the connectivity deadline", async (t) => {
  for (const source of ["deadline", "caller"] as const) {
    const h = harness();
    const caller = new AbortController();
    const deadline = new AbortController();
    const durations: number[] = [];
    const timeout = t.mock.method(AbortSignal, "timeout", (duration: number) => {
      durations.push(duration);
      return deadline.signal;
    });
    await testModelConnectivity.call(
      h.runtime,
      {
        selection: { providerId: "custom", modelId: "unregistered" },
      },
      { rawModelFactory: () => h.model, abortSignal: caller.signal },
    );
    assert.deepEqual(durations, [60_000]);
    const reason = new Error(source);
    (source === "deadline" ? deadline : caller).abort(reason);
    assert.equal(h.requests[0]?.abortSignal?.aborted, true);
    assert.equal(h.requests[0]?.abortSignal?.reason, reason);
    timeout.mock.restore();
  }
});

test("default core connectivity still calls the strict shared factory", async () => {
  const h = harness();
  await assert.rejects(
    testModelConnectivity.call(h.runtime, {
      selection: { providerId: "custom", modelId: "unregistered" },
    }),
    /strict shared factory/,
  );
  assert.equal(h.ordinaryCalls(), 1);
});

test("failed, unfinished and cancelled probes do not replace the shared factory", async () => {
  for (const outcome of ["error", "unfinished", "abort"] as const) {
    const h = harness(outcome);
    const controller = new AbortController();
    if (outcome === "abort") controller.abort(new DOMException("cancelled", "AbortError"));
    await assert.rejects(
      testModelConnectivity.call(
        h.runtime,
        {
          selection: { providerId: "custom", modelId: "unregistered" },
        },
        { rawModelFactory: () => h.model, abortSignal: controller.signal },
      ),
    );
    assert.equal(h.runtime.modelFactory, h.modelFactory);
    assert.equal(h.ordinaryCalls(), 0);
  }
});
