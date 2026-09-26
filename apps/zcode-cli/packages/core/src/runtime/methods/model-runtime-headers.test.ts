import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelErrorCode,
  ModelFailureReason,
  ModelProtocolError,
  type Model,
  type ModelSelection,
  type TraceContext,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  activateExecutionFailoverAtSafeBoundary,
  classifyExecutionFailoverFailure,
  executionModelSelectionIdentity,
} from "./model-failover-router.js";
import type {
  ExecutionFailoverPolicyPort,
  ExecutionFailoverPolicyTarget,
} from "./model-failover-policy.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";

const traceContext = {} as TraceContext;
const selectionA: ModelSelection = { providerId: "provider-a", modelId: "model-a" };
const selectionB: ModelSelection = { providerId: "provider-b", modelId: "model-b" };

function createModel(selection: ModelSelection): Model {
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    options: {},
    properties: {
      contextWindow: 128_000,
      inputFormat: {
        supportsAudio: true,
        supportsImage: true,
        supportsPdf: true,
        supportsText: true,
        supportsVideo: true,
      },
      outputFormat: { supportsText: true },
      requiresMfjsToolSchema: false,
      supportsJsonSchemaOutput: true,
      supportsMidConversationSystem: true,
      supportsNativeWebSearch: false,
      supportsToolCall: true,
    },
  } as Model;
}

test("runtime-header auth failure is classified and can activate the selected provider", async () => {
  const modelA = createModel(selectionA);
  const modelB = createModel(selectionB);
  const refresh = createRefreshRuntimeHeadersBeforeModelAttempt(
    {
      providerRuntimeHeadersPort: {
        refreshBeforeModelRequest: async () => ({ headersApplied: false }),
      },
      sessionId: "session-a",
    } as unknown as AgentRuntimeInternal,
    { model: modelA, traceContext },
  );
  assert.ok(refresh);

  let authError: unknown;
  try {
    await refresh({ attempt: 1 });
  } catch (error) {
    authError = error;
  }
  assert.ok(authError instanceof ModelProtocolError);
  assert.equal(authError.code, ModelErrorCode.ModelRequestAuthMissing);
  assert.equal(authError.context?.reason, ModelFailureReason.AuthFailed);
  const reasonCode = classifyExecutionFailoverFailure(authError);
  assert.equal(reasonCode, "provider.authentication_failed");

  const target: ExecutionFailoverPolicyTarget = {
    id: "foreground-a",
    kind: "foregroundExecution",
    modelSelection: selectionB,
    revision: 1,
    sourceCommandId: "command-a",
    status: "waitingSafeBoundary",
  };
  const policy = {
    async activate(input: Parameters<ExecutionFailoverPolicyPort["activate"]>[0]) {
      await input.prepare();
      input.commit();
      return true;
    },
    resolve: () => target,
    settle: async () => undefined,
  } as ExecutionFailoverPolicyPort;
  const runtime = {
    activeForegroundExecution: undefined,
    config: { taskType: "interactive" },
    contextBuilder: null,
    contextInitialized: false,
    executionFailoverPolicyPort: policy,
    executionFailoverScope: { foregroundExecutionId: "foreground-a" },
    executionFailoverScopeLifetime: "turn",
    failoverModelFactory: () => modelB,
  } as unknown as AgentRuntimeInternal;
  const state = {
    executionFailoverTransitionCount: 0,
    executionFailoverUnsafePolicies: new Set<string>(),
    executionFailoverVisitedModels: new Set([executionModelSelectionIdentity(selectionA)]),
    model: modelA,
    turnAbortSignal: new AbortController().signal,
    turnRequestState: { entries: [], outputTokenContinuationCount: 0 },
    turnTraceContext: traceContext,
  } as RegularTurnLoopState;

  assert.equal(
    await activateExecutionFailoverAtSafeBoundary(runtime, state, { reasonCode }),
    "activated",
  );
  assert.equal(state.model.providerId, selectionB.providerId);
  assert.equal(state.model.modelId, selectionB.modelId);
});

test("cancel, timeout, and unrelated local failures are not authentication failovers", () => {
  const cancellation = new Error("cancelled");
  const controller = new AbortController();
  controller.abort(cancellation);
  assert.equal(classifyExecutionFailoverFailure(cancellation, controller.signal), undefined);
  assert.equal(
    classifyExecutionFailoverFailure(
      new ModelProtocolError(ModelErrorCode.ModelRequestTimeout, "runtime header timeout"),
    ),
    undefined,
  );
  assert.equal(classifyExecutionFailoverFailure(new Error("local validation failed")), undefined);
});
