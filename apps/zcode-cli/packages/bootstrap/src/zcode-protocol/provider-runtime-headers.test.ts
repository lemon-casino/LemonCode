import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelErrorCode,
  ModelFailureReason,
  ModelProtocolError,
  type TraceContext,
} from "@zcode/contracts";
import type { ZCodeProviderRuntimeHeadersResponse, ZCodeWorkspaceRef } from "@zcode/shared";
import { createProviderRuntimeHeadersPort } from "./provider-runtime-headers.js";
import { ProtocolRequestError, type ZCodeProtocolAgentServerContext } from "./server-types.js";

const workspace = {
  workspaceKey: "workspace-key",
  workspacePath: "C:/workspace",
} satisfies ZCodeWorkspaceRef;
const traceContext = {} as TraceContext;

function createPort(
  requestClient: () => Promise<ZCodeProviderRuntimeHeadersResponse>,
): ReturnType<typeof createProviderRuntimeHeadersPort> {
  return createProviderRuntimeHeadersPort(
    {
      notify() {},
      requestClient,
    } as unknown as ZCodeProtocolAgentServerContext,
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
