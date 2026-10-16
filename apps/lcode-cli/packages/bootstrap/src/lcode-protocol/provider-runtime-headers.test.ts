import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelErrorCode,
  ModelFailureReason,
  ModelProtocolError,
  type TraceContext,
} from "@lcode/contracts";
import type { LCodeProviderRuntimeHeadersResponse, LCodeWorkspaceRef } from "@lcode/shared";
import { createProviderRuntimeHeadersPort } from "./provider-runtime-headers.js";
import { lcodeProtocolMethods } from "@lcode/shared";
import { ProtocolRequestError, type LCodeProtocolAgentServerContext } from "./server-types.js";

const workspace = {
  workspaceKey: "workspace-key",
  workspacePath: "C:/workspace",
} satisfies LCodeWorkspaceRef;
const traceContext = {} as TraceContext;

function createPort(
  requestClient: () => Promise<LCodeProviderRuntimeHeadersResponse>,
): ReturnType<typeof createProviderRuntimeHeadersPort> {
  return createProviderRuntimeHeadersPort(
    {
      notify() {},
      requestClient,
    } as unknown as LCodeProtocolAgentServerContext,
    workspace,
  );
}

function refresh(port: ReturnType<typeof createProviderRuntimeHeadersPort>) {
  return port.refreshBeforeModelRequest({
    modelId: "model-a",
    providerId: "provider-a",
    reason: "model-request",
    sessionId: "session-a" as never,
    traceContext,
  });
}

function assertAuthMissing(error: unknown): boolean {
  assert.ok(error instanceof ModelProtocolError);
  assert.equal(error.code, ModelErrorCode.ModelRequestAuthMissing);
  assert.equal(error.context?.reason, ModelFailureReason.AuthFailed);
  return true;
}

test("routing context is negotiated and an older Host receives exactly the legacy auth shape", async () => {
  for (const supported of [false, true]) {
    let params: Record<string, unknown> | undefined;
    const port = createProviderRuntimeHeadersPort(
      {
        notify() {},
        requestClient: async (method: string, input: Record<string, unknown>) => {
          if (method === lcodeProtocolMethods.interactionProviderRoutingCapabilities) {
            if (!supported) throw new ProtocolRequestError(-32601, "Method not found");
            return { capabilities: ["single-attempt-routing-v1"] };
          }
          params = input;
          return { headersApplied: true, requestAuth: { apiKey: "synthetic" } };
        },
      } as unknown as LCodeProtocolAgentServerContext,
      workspace,
    );
    await refresh(port);
    assert.equal(Boolean(params?.routingInvocation), supported);
  }
});

test("headersApplied=false becomes a structured request-auth failure", async () => {
  const port = createPort(async () => ({
    headersApplied: false,
    errorMessage: "credentials unavailable",
  }));

  await assert.rejects(refresh(port), assertAuthMissing);
});

test("structured Host credential failures retain request-auth attribution", async () => {
  const hostError = new ProtocolRequestError(-32603, "credential parsing failed", {
    code: ModelErrorCode.ModelRequestAuthMissing,
    reason: ModelFailureReason.AuthFailed,
  });
  const port = createPort(async () => {
    throw hostError;
  });

  await assert.rejects(refresh(port), assertAuthMissing);
});

test("timeouts and non-authentication local failures are not reclassified as auth failures", async () => {
  const timeout = new ProtocolRequestError(-32022, "timed out");
  await assert.rejects(refresh(createPort(async () => Promise.reject(timeout))), (error) => {
    assert.ok(error instanceof ProtocolRequestError);
    assert.equal(error.code, -32022);
    assert.notEqual(error, timeout);
    return true;
  });

  const localFailure = new Error("local transport failed");
  await assert.rejects(
    refresh(createPort(async () => Promise.reject(localFailure))),
    (error) => error === localFailure,
  );
});
