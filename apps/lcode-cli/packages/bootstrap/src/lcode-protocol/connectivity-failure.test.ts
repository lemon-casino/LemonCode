import assert from "node:assert/strict";
import test from "node:test";
import { AiSdkModelAdapterError, ProviderBusinessError } from "@lcode/adapters/model";
import {
  CoreErrorType,
  ModelErrorCode,
  ModelProtocolError,
  createCoreError,
} from "@lcode/contracts";
import { testProviderModelConnectivity } from "./workspace-model-runtime.js";
import { ProtocolRequestError, type LCodeProtocolAgentServerContext } from "./server-types.js";

const params = {
  workspace: { workspaceKey: "/workspace", workspacePath: "/workspace" },
  selection: { providerId: "custom", modelId: "deleted" },
  mode: "temporary",
};

function providerFailure(code: string | undefined, responseStatus = 404) {
  return new ProviderBusinessError({
    providerId: "custom",
    providerKind: "openai-compatible",
    providerCode: code,
    responseStatus,
    providerMessage: "fixture provider response",
    responseBodySummary: { error: { code } },
  });
}

function sdkFailure(data: unknown, statusCode = 404, responseBody?: string) {
  // SDK 官方跨副本识别标记；bootstrap 不新增对 ai 包的运行时依赖。
  return Object.assign(new Error("fixture SDK response"), {
    name: "AI_APICallError",
    [Symbol.for("vercel.ai.error.AI_APICallError")]: true,
    statusCode,
    data,
    responseBody,
  });
}

function context(error: unknown) {
  return {
    sessions: new Map([
      [
        "session",
        {
          workspace: params.workspace,
          app: {
            testModelConnectivity: async () => {
              throw error;
            },
          },
        },
      ],
    ]),
    deps: {},
  } as unknown as LCodeProtocolAgentServerContext;
}

async function failureCode(error: unknown) {
  const result = await testProviderModelConnectivity(context(error), params);
  assert.equal(result.success, false);
  if (result.success) throw new Error("expected failed probe");
  return result.error.code;
}

test("only exact upstream model rejection codes produce the cleanup result", async () => {
  for (const code of ["model_not_found", "invalid_model"]) {
    for (const status of [400, 404, 422]) {
      const error = new AiSdkModelAdapterError(ModelErrorCode.ModelRequestFailed, "probe failed", {
        cause: sdkFailure(undefined, status),
      });
      Object.assign(error.cause as Error, { cause: providerFailure(code, status) });
      const wrapped = createCoreError(CoreErrorType.ModelError, "probe failed", { cause: error });
      assert.equal(await failureCode(wrapped), "model-not-found");
    }
  }
});

test("SDK parsed payload and raw JSON response retain exact model rejection evidence", async () => {
  assert.equal(
    await failureCode(sdkFailure({ error: { code: "model_not_found" } })),
    "model-not-found",
  );
  assert.equal(
    await failureCode(
      sdkFailure(undefined, 400, JSON.stringify({ error: { code: "invalid_model" } })),
    ),
    "model-not-found",
  );
});

test("HTTP failures never become cleanup evidence without an exact model rejection payload", async () => {
  for (const status of [400, 404, 401, 403, 408, 429, 500, 503]) {
    assert.equal(
      await failureCode(
        sdkFailure({ error: { message: "model_not_found", code: "unknown" } }, status),
      ),
      undefined,
    );
  }
  // 即使上游误带模型码，鉴权、限流、服务故障等状态仍优先保留，不能自动删除。
  for (const status of [200, 401, 403, 408, 429, 500, 503]) {
    assert.equal(await failureCode(providerFailure("model_not_found", status)), undefined);
    assert.equal(
      await failureCode(sdkFailure({ error: { code: "invalid_model" } }, status)),
      undefined,
    );
  }
});

test("local selection/configuration, network, abort, timeout, strings and lookalike objects stay unknown", async () => {
  const confirmedCause = providerFailure("model_not_found");
  const unknowns: unknown[] = [
    new ModelProtocolError(ModelErrorCode.ModelNotFound, "model_not_found"),
    createCoreError(CoreErrorType.ConfigurationError, "missing model", { cause: confirmedCause }),
    createCoreError(CoreErrorType.ModelTimeout, "timeout", { cause: confirmedCause }),
    Object.assign(new Error("network"), { code: "ECONNRESET" }),
    Object.assign(new DOMException("cancelled", "AbortError"), { cause: confirmedCause }),
    Object.assign(new DOMException("timeout", "TimeoutError"), { cause: confirmedCause }),
    new AiSdkModelAdapterError(ModelErrorCode.ModelRequestCancelled, "cancelled", {
      cause: confirmedCause,
      context: { reason: "cancelled" },
    }),
    new AiSdkModelAdapterError(ModelErrorCode.ModelRequestFailed, "network", {
      cause: confirmedCause,
      context: { source: "network" },
    }),
    "model_not_found",
    new Error("The model does not exist"),
    { code: "model_not_found", statusCode: 404 },
    { name: "AI_APICallError", statusCode: 404, data: { error: { code: "model_not_found" } } },
    { context: { providerCode: "model_not_found", statusCode: 404 } },
    sdkFailure({ error: { code: "MODEL_NOT_FOUND" } }),
    sdkFailure(undefined, 404, "not JSON model_not_found"),
    sdkFailure({ error: { type: "model_not_found" } }),
  ];
  for (const error of unknowns) assert.equal(await failureCode(error), undefined);
  const cyclic = new Error("cyclic") as Error & { cause: unknown };
  cyclic.cause = cyclic;
  assert.equal(await failureCode(cyclic), undefined);
});

test("connectivity failures expose only message and optional stable code", async () => {
  const error = new AiSdkModelAdapterError(ModelErrorCode.ModelRequestFailed, "probe failed", {
    cause: providerFailure("model_not_found"),
    context: {
      requestHeaders: { authorization: "fixture-secret" },
      responseBody: "private fixture",
    },
  });
  const result = await testProviderModelConnectivity(context(error), params);
  assert.equal(result.success, false);
  if (result.success) throw new Error("expected failed probe");
  assert.deepEqual(Object.keys(result.error).sort(), ["code", "message"]);
  assert.equal(JSON.stringify(result).includes("fixture-secret"), false);
  assert.equal(JSON.stringify(result).includes("private fixture"), false);
});

test("invalid params and protocol faults retain their protocol error boundary", async () => {
  const executionError = new Error("should not reach execution");
  await assert.rejects(
    testProviderModelConnectivity(context(executionError), { ...params, providerConfig: {} }),
    ProtocolRequestError,
  );
  const protocolError = new ProtocolRequestError(-32022, "reverse request timed out");
  await assert.rejects(
    testProviderModelConnectivity(context(protocolError), params),
    (error) => error === protocolError,
  );
});
