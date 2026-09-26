import assert from "node:assert/strict";
import test from "node:test";
import {
  createModelId,
  createModelProviderId,
  type ModelNetworkStatusEvent,
  type ModelStreamEvent,
} from "@zcode/contracts";
import { AiSdkModelAdapterError } from "./errors.js";
import { runGenerateText } from "./runner-generate.js";
import type {
  AiSdkModelRuntime,
  AiSdkModelTextRequest,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";
import { runStreamText } from "./runner-stream.js";

type ModelRetryYieldInput = Parameters<
  NonNullable<AiSdkModelTextRequest["shouldYieldRetryToFailover"]>
>[0];

const resolved = {
  model: {},
  modelId: createModelId("model-a"),
  providerId: createModelProviderId("provider-a"),
  providerKind: "openai-compatible",
  properties: {
    contextWindow: 128_000,
    inputFormat: { image: false, text: true },
    outputFormat: { text: true },
    requiresMfjsToolSchema: false,
    supportsJsonSchemaOutput: false,
    supportsMidConversationSystem: true,
    supportsNativeWebSearch: false,
    supportsToolCall: true,
  },
} as unknown as ResolvedAiSdkModel;

const retry = {
  backoffFactor: 1,
  baseDelayMs: 0,
  jitter: false,
  maxAttempts: 3,
  maxDelayMs: 0,
};

function networkFailure(): Error & { code: string } {
  return Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
}

function failingFullStream(): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<never>> {
          throw networkFailure();
        },
      };
    },
  };
}

function request(
  failures: ModelRetryYieldInput[],
  events: ModelNetworkStatusEvent[],
  yieldOnEvaluation = 1,
): AiSdkModelTextRequest {
  return {
    messages: [{ content: "continue", role: "user" }],
    shouldYieldRetryToFailover: (failure) => {
      failures.push(failure);
      return failures.length >= yieldOnEvaluation;
    },
    statusSink: {
      publish(event) {
        events.push(event);
      },
    },
  };
}

function assertYielded(error: unknown): boolean {
  assert.ok(error instanceof AiSdkModelAdapterError);
  assert.equal(error.context?.retryYieldedToFailover, true);
  assert.equal(error.context?.retryYieldConsumedRetryAttempts, 1);
  return true;
}

test("generate yields a retry to the execution failover policy before a second provider call", async () => {
  let providerCalls = 0;
  const failures: ModelRetryYieldInput[] = [];
  const events: ModelNetworkStatusEvent[] = [];
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      providerCalls += 1;
      throw networkFailure();
    },
    streamText() {
      throw new Error("streamText should not be called");
    },
  };

  await assert.rejects(
    runGenerateText({
      env: {},
      modelIoFullRetentionEnabled: false,
      request: request(failures, events),
      resolveModel: () => resolved,
      resolved,
      retry,
      runtime,
    }),
    assertYielded,
  );

  assert.equal(providerCalls, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.providerId, "provider-a");
  assert.equal(failures[0]?.modelId, "model-a");
  assert.equal(failures[0]?.retryable, true);
  assert.equal(
    events.some((event) => event.type === "model_retry_scheduled"),
    true,
  );
});

test("stream yields a retry to the execution failover policy before a second provider call", async () => {
  let providerCalls = 0;
  const failures: ModelRetryYieldInput[] = [];
  const events: ModelNetworkStatusEvent[] = [];
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      throw new Error("generateText should not be called");
    },
    streamText() {
      providerCalls += 1;
      return {
        fullStream: failingFullStream(),
      } as unknown as ReturnType<AiSdkModelRuntime["streamText"]>;
    },
  };

  await assert.rejects(async () => {
    for await (const _event of runStreamText({
      env: {},
      modelIoFullRetentionEnabled: false,
      request: request(failures, events),
      resolveModel: () => resolved,
      resolved,
      retry,
      runtime,
      streamIdleTimeoutMs: 1_000,
    })) {
      // The fixture fails before producing a visible event.
    }
  }, assertYielded);

  assert.equal(providerCalls, 1);
  assert.equal(failures.length, 1);
  assert.equal(
    events.some((event) => event.type === "model_retry_scheduled"),
    true,
  );
});

test("stream closes the failed iterator and releases admission before awaiting retry yield", async () => {
  let iteratorClosed = false;
  let iteratorClosedAtGate = false;
  let releaseCount = 0;
  let releaseCountAtGate = 0;
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      throw new Error("generateText should not be called");
    },
    streamText() {
      return {
        fullStream: {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<never>> {
                throw networkFailure();
              },
              async return(): Promise<IteratorResult<never>> {
                iteratorClosed = true;
                return { done: true, value: undefined as never };
              },
            };
          },
        },
      } as unknown as ReturnType<AiSdkModelRuntime["streamText"]>;
    },
  };

  await assert.rejects(async () => {
    for await (const _event of runStreamText({
      env: {},
      modelIoFullRetentionEnabled: false,
      request: {
        messages: [{ content: "continue", role: "user" }],
        modelRequestAdmission: {
          async acquire() {
            return {
              publish() {},
              release() {
                releaseCount += 1;
              },
            };
          },
        },
        shouldYieldRetryToFailover: () => {
          iteratorClosedAtGate = iteratorClosed;
          releaseCountAtGate = releaseCount;
          return true;
        },
      },
      resolveModel: () => resolved,
      resolved,
      retry,
      runtime,
      streamIdleTimeoutMs: 1_000,
    })) {
      assert.fail("the failed stream must not emit a visible event");
    }
  }, assertYielded);

  assert.equal(iteratorClosedAtGate, true);
  assert.equal(releaseCountAtGate, 1);
});

test("stream error chunk yields an armed failover before a second provider call", async () => {
  let providerCalls = 0;
  const failures: ModelRetryYieldInput[] = [];
  const events: ModelNetworkStatusEvent[] = [];
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      throw new Error("generateText should not be called");
    },
    streamText() {
      providerCalls += 1;
      return {
        fullStream: {
          async *[Symbol.asyncIterator]() {
            yield { error: networkFailure(), type: "error" };
          },
        },
      } as unknown as ReturnType<AiSdkModelRuntime["streamText"]>;
    },
  };

  await assert.rejects(async () => {
    for await (const _event of runStreamText({
      env: {},
      modelIoFullRetentionEnabled: false,
      request: request(failures, events),
      resolveModel: () => resolved,
      resolved,
      retry,
      runtime,
      streamIdleTimeoutMs: 1_000,
    })) {
      // error chunk 在可见事件生成前即交回 failover Router。
    }
  }, assertYielded);

  assert.equal(providerCalls, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.providerId, "provider-a");
  assert.equal(failures[0]?.modelId, "model-a");
  assert.equal(
    events.some((event) => event.type === "model_retry_scheduled"),
    true,
  );
});

test("generate rechecks failover after backoff before a second provider call", async () => {
  let providerCalls = 0;
  const failures: ModelRetryYieldInput[] = [];
  const events: ModelNetworkStatusEvent[] = [];
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      providerCalls += 1;
      throw networkFailure();
    },
    streamText() {
      throw new Error("streamText should not be called");
    },
  };

  await assert.rejects(
    runGenerateText({
      env: {},
      modelIoFullRetentionEnabled: false,
      request: request(failures, events, 2),
      resolveModel: () => resolved,
      resolved,
      retry,
      runtime,
    }),
    assertYielded,
  );

  assert.equal(providerCalls, 1);
  assert.equal(failures.length, 2);
  assert.equal(
    events.some((event) => event.type === "model_retry_scheduled"),
    true,
  );
});

test("stream rechecks failover after backoff before a second provider call", async () => {
  let providerCalls = 0;
  const failures: ModelRetryYieldInput[] = [];
  const events: ModelNetworkStatusEvent[] = [];
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      throw new Error("generateText should not be called");
    },
    streamText() {
      providerCalls += 1;
      return {
        fullStream: failingFullStream(),
      } as unknown as ReturnType<AiSdkModelRuntime["streamText"]>;
    },
  };

  await assert.rejects(async () => {
    for await (const _event of runStreamText({
      env: {},
      modelIoFullRetentionEnabled: false,
      request: request(failures, events, 2),
      resolveModel: () => resolved,
      resolved,
      retry,
      runtime,
      streamIdleTimeoutMs: 1_000,
    })) {
      // The fixture fails before producing a visible event.
    }
  }, assertYielded);

  assert.equal(providerCalls, 1);
  assert.equal(failures.length, 2);
  assert.equal(
    events.some((event) => event.type === "model_retry_scheduled"),
    true,
  );
});

test("stream error chunk rechecks failover after backoff before a second provider call", async () => {
  let providerCalls = 0;
  const failures: ModelRetryYieldInput[] = [];
  const events: ModelNetworkStatusEvent[] = [];
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      throw new Error("generateText should not be called");
    },
    streamText() {
      providerCalls += 1;
      return {
        fullStream: {
          async *[Symbol.asyncIterator]() {
            yield { error: networkFailure(), type: "error" };
          },
        },
      } as unknown as ReturnType<AiSdkModelRuntime["streamText"]>;
    },
  };

  await assert.rejects(async () => {
    for await (const _event of runStreamText({
      env: {},
      modelIoFullRetentionEnabled: false,
      request: request(failures, events, 2),
      resolveModel: () => resolved,
      resolved,
      retry,
      runtime,
      streamIdleTimeoutMs: 1_000,
    })) {
      // backoff 后重新武装时仍须在下一次旧 provider 请求前交回 Router。
    }
  }, assertYielded);

  assert.equal(providerCalls, 1);
  assert.equal(failures.length, 2);
  assert.equal(
    events.some((event) => event.type === "model_retry_scheduled"),
    true,
  );
});

test("generate rechecks failover after retry admission before invoking the provider", async () => {
  let providerCalls = 0;
  let admissionCount = 0;
  let releaseCount = 0;
  let armed = false;
  const failures: ModelRetryYieldInput[] = [];
  const events: ModelNetworkStatusEvent[] = [];
  const retryRequest: AiSdkModelTextRequest = {
    messages: [{ content: "continue", role: "user" }],
    modelRequestAdmission: {
      async acquire() {
        admissionCount += 1;
        if (admissionCount === 2) armed = true;
        return {
          publish() {},
          release() {
            releaseCount += 1;
          },
        };
      },
    },
    shouldYieldRetryToFailover: (failure) => {
      failures.push(failure);
      if (armed) {
        assert.equal(releaseCount, 1, "the final gate must still hold the current admission");
      }
      return armed;
    },
    statusSink: {
      publish(event) {
        events.push(event);
      },
    },
  };
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      providerCalls += 1;
      throw networkFailure();
    },
    streamText() {
      throw new Error("streamText should not be called");
    },
  };

  await assert.rejects(
    runGenerateText({
      env: {},
      modelIoFullRetentionEnabled: false,
      request: retryRequest,
      resolveModel: () => resolved,
      resolved,
      retry,
      runtime,
    }),
    assertYielded,
  );

  assert.equal(admissionCount, 2);
  assert.equal(providerCalls, 1);
  assert.equal(releaseCount, 2);
  assert.equal(failures.length, 2);
  assert.deepEqual(
    events.slice(-2).map((event) => event.type),
    ["model_request_started", "model_request_failed"],
  );
  const closure = events.at(-1);
  assert.equal(closure?.type, "model_request_failed");
  if (closure?.type === "model_request_failed") {
    assert.equal(closure.reason, "cancelled");
    assert.equal(closure.errorCode, "model_request_cancelled");
    assert.equal(closure.errorPhase, "prepare");
    assert.equal(closure.providerErrorCode, undefined);
    assert.equal(closure.statusCode, undefined);
  }
});

test("stream rechecks failover after retry admission before invoking the provider", async () => {
  let providerCalls = 0;
  let admissionCount = 0;
  let releaseCount = 0;
  let armed = false;
  const failures: ModelRetryYieldInput[] = [];
  const events: ModelNetworkStatusEvent[] = [];
  const retryRequest: AiSdkModelTextRequest = {
    messages: [{ content: "continue", role: "user" }],
    modelRequestAdmission: {
      async acquire() {
        admissionCount += 1;
        if (admissionCount === 2) armed = true;
        return {
          publish() {},
          release() {
            releaseCount += 1;
          },
        };
      },
    },
    shouldYieldRetryToFailover: (failure) => {
      failures.push(failure);
      if (armed) {
        assert.equal(releaseCount, 1, "the final gate must still hold the current admission");
      }
      return armed;
    },
    statusSink: {
      publish(event) {
        events.push(event);
      },
    },
  };
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      throw new Error("generateText should not be called");
    },
    streamText() {
      providerCalls += 1;
      return {
        fullStream: failingFullStream(),
      } as unknown as ReturnType<AiSdkModelRuntime["streamText"]>;
    },
  };

  await assert.rejects(async () => {
    for await (const _event of runStreamText({
      env: {},
      modelIoFullRetentionEnabled: false,
      request: retryRequest,
      resolveModel: () => resolved,
      resolved,
      retry,
      runtime,
      streamIdleTimeoutMs: 1_000,
    })) {
      // The fixture fails before producing a visible event.
    }
  }, assertYielded);

  assert.equal(admissionCount, 2);
  assert.equal(providerCalls, 1);
  assert.equal(releaseCount, 2);
  assert.equal(failures.length, 2);
  assert.deepEqual(
    events.slice(-2).map((event) => event.type),
    ["model_request_started", "model_request_failed"],
  );
  const closure = events.at(-1);
  assert.equal(closure?.type, "model_request_failed");
  if (closure?.type === "model_request_failed") {
    assert.equal(closure.reason, "cancelled");
    assert.equal(closure.errorCode, "model_request_cancelled");
    assert.equal(closure.errorPhase, "prepare");
    assert.equal(closure.providerErrorCode, undefined);
    assert.equal(closure.statusCode, undefined);
  }
});

test("stream error chunk rechecks failover after retry admission", async () => {
  let providerCalls = 0;
  let admissionCount = 0;
  let releaseCount = 0;
  let armed = false;
  const failures: ModelRetryYieldInput[] = [];
  const events: ModelNetworkStatusEvent[] = [];
  const retryRequest: AiSdkModelTextRequest = {
    messages: [{ content: "continue", role: "user" }],
    modelRequestAdmission: {
      async acquire() {
        admissionCount += 1;
        if (admissionCount === 2) armed = true;
        return {
          publish() {},
          release() {
            releaseCount += 1;
          },
        };
      },
    },
    shouldYieldRetryToFailover: (failure) => {
      failures.push(failure);
      return armed;
    },
    statusSink: {
      publish(event) {
        events.push(event);
      },
    },
  };
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      throw new Error("generateText should not be called");
    },
    streamText() {
      providerCalls += 1;
      return {
        fullStream: {
          async *[Symbol.asyncIterator]() {
            yield { error: networkFailure(), type: "error" };
          },
        },
      } as unknown as ReturnType<AiSdkModelRuntime["streamText"]>;
    },
  };

  await assert.rejects(async () => {
    for await (const _event of runStreamText({
      env: {},
      modelIoFullRetentionEnabled: false,
      request: retryRequest,
      resolveModel: () => resolved,
      resolved,
      retry,
      runtime,
      streamIdleTimeoutMs: 1_000,
    })) {
      // error chunk 的控制流也必须把旧失败带到下一次物理调用前。
    }
  }, assertYielded);

  assert.equal(admissionCount, 2);
  assert.equal(providerCalls, 1);
  assert.equal(releaseCount, 2);
  assert.equal(failures.length, 2);
});

test("generate awaits an asynchronous retry-yield decision before another provider call", async () => {
  let providerCalls = 0;
  let releaseDecision: (() => void) | undefined;
  const decisionReady = new Promise<void>((resolve) => {
    releaseDecision = resolve;
  });
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      providerCalls += 1;
      throw networkFailure();
    },
    streamText() {
      throw new Error("streamText should not be called");
    },
  };
  const pending = runGenerateText({
    env: {},
    modelIoFullRetentionEnabled: false,
    request: {
      messages: [{ content: "continue", role: "user" }],
      shouldYieldRetryToFailover: async () => {
        await decisionReady;
        return {
          policyRevision: 2,
          shouldYield: true,
          sourceCommandId: "command-c",
        };
      },
    },
    resolveModel: () => resolved,
    resolved,
    retry,
    runtime,
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(providerCalls, 1);
  releaseDecision?.();
  await assert.rejects(pending, (error: unknown) => {
    assertYielded(error);
    assert.ok(error instanceof AiSdkModelAdapterError);
    assert.equal(error.context?.retryYieldPolicyRevision, 2);
    assert.equal(error.context?.retryYieldSourceCommandId, "command-c");
    return true;
  });
  assert.equal(providerCalls, 1);
});

test("generate empty completion yields after backoff without a second provider call", async () => {
  let providerCalls = 0;
  const failures: ModelRetryYieldInput[] = [];
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      providerCalls += 1;
      return {
        finishReason: "unknown",
        text: "",
        totalUsage: {},
        usage: {},
      } as unknown as Awaited<ReturnType<AiSdkModelRuntime["generateText"]>>;
    },
    streamText() {
      throw new Error("streamText should not be called");
    },
  };

  await assert.rejects(
    runGenerateText({
      env: {},
      modelIoFullRetentionEnabled: false,
      request: {
        messages: [{ content: "continue", role: "user" }],
        shouldYieldRetryToFailover: async (failure) => {
          failures.push(failure);
          return true;
        },
      },
      resolveModel: () => resolved,
      resolved,
      retry,
      runtime,
    }),
    assertYielded,
  );

  assert.equal(providerCalls, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.reason, "server_error");
});

test("stream empty completion yields after backoff without a second provider call", async () => {
  let providerCalls = 0;
  const failures: ModelRetryYieldInput[] = [];
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      throw new Error("generateText should not be called");
    },
    streamText() {
      providerCalls += 1;
      return {
        fullStream: {
          async *[Symbol.asyncIterator]() {
            yield { finishReason: "unknown", type: "finish", usage: {} };
          },
        },
      } as unknown as ReturnType<AiSdkModelRuntime["streamText"]>;
    },
  };

  await assert.rejects(async () => {
    for await (const _event of runStreamText({
      env: {},
      modelIoFullRetentionEnabled: false,
      request: {
        messages: [{ content: "continue", role: "user" }],
        shouldYieldRetryToFailover: async (failure) => {
          failures.push(failure);
          return true;
        },
      },
      resolveModel: () => resolved,
      resolved,
      retry,
      runtime,
      streamIdleTimeoutMs: 1_000,
    })) {
      assert.fail("empty retry must not expose the discarded completion");
    }
  }, assertYielded);

  assert.equal(providerCalls, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.reason, "server_error");
});

test("generate restores retry yield when the local signature-repair request is empty", async () => {
  let providerCalls = 0;
  let retryYieldEvaluations = 0;
  const anthropicResolved = {
    ...resolved,
    providerKind: "anthropic",
  } as unknown as ResolvedAiSdkModel;
  const signatureError = Object.assign(
    new Error("signature in thinking block cannot be modified"),
    { statusCode: 400 },
  );
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      providerCalls += 1;
      if (providerCalls === 1) throw signatureError;
      if (providerCalls === 2) {
        return {
          finishReason: "unknown",
          text: "",
          totalUsage: {},
          usage: {},
        } as unknown as Awaited<ReturnType<AiSdkModelRuntime["generateText"]>>;
      }
      return {
        finishReason: "stop",
        text: "recovered",
        totalUsage: {},
        usage: {},
      } as unknown as Awaited<ReturnType<AiSdkModelRuntime["generateText"]>>;
    },
    streamText() {
      throw new Error("streamText should not be called");
    },
  };

  await assert.rejects(
    runGenerateText({
      env: {},
      modelIoFullRetentionEnabled: false,
      request: {
        messages: [
          {
            content: [
              {
                providerOptions: { anthropic: { signature: "signed" } },
                text: "private thinking",
                type: "reasoning",
              },
              { text: "portable answer", type: "text" },
            ],
            modelId: anthropicResolved.modelId,
            providerId: anthropicResolved.providerId,
            role: "assistant",
          },
          { content: "continue", role: "user" },
        ],
        shouldYieldRetryToFailover: () => {
          retryYieldEvaluations += 1;
          return true;
        },
      },
      resolveModel: () => anthropicResolved,
      resolved: anthropicResolved,
      retry,
      runtime,
    }),
    assertYielded,
  );

  assert.equal(providerCalls, 2);
  assert.equal(retryYieldEvaluations, 1);
});

test("stream restores retry yield when the local signature-repair request is empty", async () => {
  let providerCalls = 0;
  let retryYieldEvaluations = 0;
  const anthropicResolved = {
    ...resolved,
    providerKind: "anthropic",
  } as unknown as ResolvedAiSdkModel;
  const signatureError = Object.assign(
    new Error("signature in thinking block cannot be modified"),
    { statusCode: 400 },
  );
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      throw new Error("generateText should not be called");
    },
    streamText() {
      providerCalls += 1;
      const call = providerCalls;
      return {
        fullStream: {
          async *[Symbol.asyncIterator]() {
            if (call === 1) throw signatureError;
            if (call === 2) {
              yield { finishReason: "unknown", type: "finish", usage: {} };
              return;
            }
            yield { id: "text-1", text: "recovered", type: "text-delta" };
            yield { finishReason: "stop", type: "finish", usage: {} };
          },
        },
      } as unknown as ReturnType<AiSdkModelRuntime["streamText"]>;
    },
  };
  const events: ModelStreamEvent[] = [];

  await assert.rejects(async () => {
    for await (const event of runStreamText({
      env: {},
      modelIoFullRetentionEnabled: false,
      request: {
        messages: [
          {
            content: [
              {
                providerOptions: { anthropic: { signature: "signed" } },
                text: "private thinking",
                type: "reasoning",
              },
              { text: "portable answer", type: "text" },
            ],
            modelId: anthropicResolved.modelId,
            providerId: anthropicResolved.providerId,
            role: "assistant",
          },
          { content: "continue", role: "user" },
        ],
        shouldYieldRetryToFailover: () => {
          retryYieldEvaluations += 1;
          return true;
        },
      },
      resolveModel: () => anthropicResolved,
      resolved: anthropicResolved,
      retry,
      runtime,
      streamIdleTimeoutMs: 1_000,
    })) {
      events.push(event);
    }
  }, assertYielded);

  assert.equal(providerCalls, 2);
  assert.equal(retryYieldEvaluations, 1);
  assert.deepEqual(events, []);
});

test("generate resumes the original bounded retry budget from a global attempt offset", async () => {
  let providerCalls = 0;
  const events: ModelNetworkStatusEvent[] = [];
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      providerCalls += 1;
      throw networkFailure();
    },
    streamText() {
      throw new Error("streamText should not be called");
    },
  };

  await assert.rejects(
    runGenerateText({
      env: {},
      modelIoFullRetentionEnabled: false,
      request: {
        messages: [{ content: "continue", role: "user" }],
        retryAttemptOffset: 1,
        statusSink: {
          publish: (event) => {
            events.push(event);
          },
        },
      },
      resolveModel: () => resolved,
      resolved,
      retry: { ...retry, maxAttempts: 2 },
      runtime,
    }),
  );

  assert.equal(providerCalls, 1);
  assert.equal(events.find((event) => event.type === "model_request_started")?.attempt, 2);
  assert.equal(
    events.some((event) => event.type === "model_retry_scheduled"),
    false,
  );
});

test("stream resumes the original bounded retry budget from a global attempt offset", async () => {
  let providerCalls = 0;
  const events: ModelNetworkStatusEvent[] = [];
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      throw new Error("generateText should not be called");
    },
    streamText() {
      providerCalls += 1;
      return { fullStream: failingFullStream() } as unknown as ReturnType<
        AiSdkModelRuntime["streamText"]
      >;
    },
  };

  await assert.rejects(async () => {
    for await (const _event of runStreamText({
      env: {},
      modelIoFullRetentionEnabled: false,
      request: {
        messages: [{ content: "continue", role: "user" }],
        retryAttemptOffset: 1,
        statusSink: {
          publish: (event) => {
            events.push(event);
          },
        },
      },
      resolveModel: () => resolved,
      resolved,
      retry: { ...retry, maxAttempts: 2 },
      runtime,
      streamIdleTimeoutMs: 1_000,
    })) {
      assert.fail("the failed stream must not emit a visible event");
    }
  });

  assert.equal(providerCalls, 1);
  assert.equal(events.find((event) => event.type === "model_request_started")?.attempt, 2);
  assert.equal(
    events.some((event) => event.type === "model_retry_scheduled"),
    false,
  );
});

test("off-peak queue yield reports zero consumed retry attempts", async () => {
  let providerCalls = 0;
  const offPeakResolved = {
    ...resolved,
    accountAccess: { mode: "off-peak", type: "zhipu-account" },
  } as unknown as ResolvedAiSdkModel;
  const queueFailure = Object.assign(new Error("queued"), {
    responseHeaders: { "retry-after-ms": "0" },
    statusCode: 429,
  });
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      providerCalls += 1;
      throw queueFailure;
    },
    streamText() {
      throw new Error("streamText should not be called");
    },
  };

  await assert.rejects(
    runGenerateText({
      env: {},
      modelIoFullRetentionEnabled: false,
      request: {
        messages: [{ content: "continue", role: "user" }],
        shouldYieldRetryToFailover: () => true,
      },
      resolveModel: () => offPeakResolved,
      resolved: offPeakResolved,
      retry,
      runtime,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AiSdkModelAdapterError);
      assert.equal(error.context?.retryYieldedToFailover, true);
      assert.equal(error.context?.retryYieldConsumedRetryAttempts, 0);
      return true;
    },
  );
  assert.equal(providerCalls, 1);
});

test("generate restores retry yield after the protected signature-repair attempt", async () => {
  let providerCalls = 0;
  const failures: ModelRetryYieldInput[] = [];
  const events: ModelNetworkStatusEvent[] = [];
  const anthropicResolved = {
    ...resolved,
    providerKind: "anthropic",
  } as unknown as ResolvedAiSdkModel;
  const signatureError = Object.assign(
    new Error("signature in thinking block cannot be modified"),
    { statusCode: 400 },
  );
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      providerCalls += 1;
      if (providerCalls === 1) throw signatureError;
      throw networkFailure();
    },
    streamText() {
      throw new Error("streamText should not be called");
    },
  };

  await assert.rejects(
    runGenerateText({
      env: {},
      modelIoFullRetentionEnabled: false,
      request: {
        messages: [
          {
            content: [
              {
                providerOptions: { anthropic: { signature: "signed" } },
                text: "private thinking",
                type: "reasoning",
              },
              { text: "portable answer", type: "text" },
            ],
            modelId: anthropicResolved.modelId,
            providerId: anthropicResolved.providerId,
            role: "assistant",
          },
          { content: "continue", role: "user" },
        ],
        retryAttemptOffset: 1,
        shouldYieldRetryToFailover: (failure) => {
          failures.push(failure);
          return true;
        },
        statusSink: {
          publish(event) {
            events.push(event);
          },
        },
      },
      resolveModel: () => anthropicResolved,
      resolved: anthropicResolved,
      retry: { ...retry, maxAttempts: 4 },
      runtime,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AiSdkModelAdapterError);
      assert.equal(error.context?.retryYieldedToFailover, true);
      assert.equal(error.context?.retryYieldConsumedRetryAttempts, 2);
      return true;
    },
  );

  assert.equal(providerCalls, 2);
  assert.deepEqual(
    failures.map((failure) => failure.attempt),
    [3],
  );
  assert.deepEqual(
    events.filter((event) => event.type === "model_request_started").map((event) => event.attempt),
    [2, 3],
  );
});

test("stream restores retry yield after the protected signature-repair attempt", async () => {
  let providerCalls = 0;
  const failures: ModelRetryYieldInput[] = [];
  const anthropicResolved = {
    ...resolved,
    providerKind: "anthropic",
  } as unknown as ResolvedAiSdkModel;
  const signatureError = Object.assign(
    new Error("signature in thinking block cannot be modified"),
    { statusCode: 400 },
  );
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      throw new Error("generateText should not be called");
    },
    streamText() {
      providerCalls += 1;
      const call = providerCalls;
      return {
        fullStream: {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<never>> {
                if (call === 1) throw signatureError;
                throw networkFailure();
              },
            };
          },
        },
      } as unknown as ReturnType<AiSdkModelRuntime["streamText"]>;
    },
  };

  await assert.rejects(
    async () => {
      for await (const _event of runStreamText({
        env: {},
        modelIoFullRetentionEnabled: false,
        request: {
          messages: [
            {
              content: [
                {
                  providerOptions: { anthropic: { signature: "signed" } },
                  text: "private thinking",
                  type: "reasoning",
                },
                { text: "portable answer", type: "text" },
              ],
              modelId: anthropicResolved.modelId,
              providerId: anthropicResolved.providerId,
              role: "assistant",
            },
            { content: "continue", role: "user" },
          ],
          retryAttemptOffset: 1,
          shouldYieldRetryToFailover: (failure) => {
            failures.push(failure);
            return true;
          },
        },
        resolveModel: () => anthropicResolved,
        resolved: anthropicResolved,
        retry: { ...retry, maxAttempts: 4 },
        runtime,
        streamIdleTimeoutMs: 1_000,
      })) {
        assert.fail("the failed stream must not emit a visible event");
      }
    },
    (error: unknown) => {
      assert.ok(error instanceof AiSdkModelAdapterError);
      assert.equal(error.context?.retryYieldedToFailover, true);
      assert.equal(error.context?.retryYieldConsumedRetryAttempts, 2);
      return true;
    },
  );

  assert.equal(providerCalls, 2);
  assert.deepEqual(
    failures.map((failure) => failure.attempt),
    [3],
  );
});

test("generate does not invoke the provider when cancellation lands in the final retry gate", async () => {
  const abortController = new AbortController();
  let providerCalls = 0;
  let gateEvaluations = 0;
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      providerCalls += 1;
      if (providerCalls === 1) throw networkFailure();
      return await new Promise<never>(() => {});
    },
    streamText() {
      throw new Error("streamText should not be called");
    },
  };

  await assert.rejects(
    runGenerateText({
      env: {},
      modelIoFullRetentionEnabled: false,
      request: {
        abortSignal: abortController.signal,
        messages: [{ content: "continue", role: "user" }],
        shouldYieldRetryToFailover: () => {
          gateEvaluations += 1;
          if (gateEvaluations === 2) {
            abortController.abort(new Error("cancelled during final retry gate"));
          }
          return false;
        },
      },
      resolveModel: () => resolved,
      resolved,
      retry,
      runtime,
    }),
  );

  assert.equal(gateEvaluations, 2);
  assert.equal(providerCalls, 1);
});

test("stream does not invoke the provider when cancellation lands in the final retry gate", async () => {
  const abortController = new AbortController();
  let providerCalls = 0;
  let gateEvaluations = 0;
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      throw new Error("generateText should not be called");
    },
    streamText() {
      providerCalls += 1;
      return {
        fullStream: failingFullStream(),
      } as unknown as ReturnType<AiSdkModelRuntime["streamText"]>;
    },
  };

  await assert.rejects(async () => {
    for await (const _event of runStreamText({
      env: {},
      modelIoFullRetentionEnabled: false,
      request: {
        abortSignal: abortController.signal,
        messages: [{ content: "continue", role: "user" }],
        shouldYieldRetryToFailover: () => {
          gateEvaluations += 1;
          if (gateEvaluations === 2) {
            abortController.abort(new Error("cancelled during final retry gate"));
          }
          return false;
        },
      },
      resolveModel: () => resolved,
      resolved,
      retry,
      runtime,
      streamIdleTimeoutMs: 1_000,
    })) {
      assert.fail("the failed stream must not emit a visible event");
    }
  });

  assert.equal(gateEvaluations, 2);
  assert.equal(providerCalls, 1);
});

test("generate observes a provider rejection when abort wins immediately after invocation", async () => {
  const abortController = new AbortController();
  let pendingObserved = false;
  const runtime: AiSdkModelRuntime = {
    generateText() {
      abortController.abort(new Error("cancelled after provider invocation"));
      return {
        // oxlint-disable-next-line unicorn/no-thenable -- This fixture verifies whether the runner observes Promise.then after fast abort.
        then(_resolve: (value: never) => void, reject: (error: unknown) => void) {
          pendingObserved = true;
          queueMicrotask(() => reject(new Error("late provider rejection")));
        },
      } as unknown as ReturnType<AiSdkModelRuntime["generateText"]>;
    },
    streamText() {
      throw new Error("streamText should not be called");
    },
  };

  await assert.rejects(
    runGenerateText({
      env: {},
      modelIoFullRetentionEnabled: false,
      request: {
        abortSignal: abortController.signal,
        messages: [{ content: "continue", role: "user" }],
      },
      resolveModel: () => resolved,
      resolved,
      retry,
      runtime,
    }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(pendingObserved, true);
});
