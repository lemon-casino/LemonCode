import assert from "node:assert/strict";
import test from "node:test";
import type { TraceContext, TraceId } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ActiveForegroundExecutionState } from "../types.js";
import { finishForegroundExecution } from "./runtime-command-queue.js";

const traceContext = {
  traceId: "trace_foreground_cleanup" as TraceId,
} as TraceContext;

test("foreground cleanup retries a failed policy append without rejecting command completion", async () => {
  const state: ActiveForegroundExecutionState = {
    controller: new AbortController(),
    disposeParentAbort: () => undefined,
    foregroundExecutionId: "foreground-cleanup-retry",
    preserveQueueAutoDrainOnCancel: false,
  };
  const retryDelays: number[] = [];
  const retainedWork: Promise<unknown>[] = [];
  const warnings: string[] = [];
  let completeAttempts = 0;
  const runtime = {
    activeForegroundExecution: state,
    executionFailoverPolicyPort: {
      complete: async () => {
        completeAttempts += 1;
        if (completeAttempts === 1) throw new Error("policy append failed");
      },
    },
    logger: {
      warn: (message: string) => {
        warnings.push(message);
      },
    },
    pendingSessionStoreDependentCloseWork: new Set<Promise<void>>(),
    trackResidencyBlockingWork: <T>(work: Promise<T>) => {
      retainedWork.push(work);
      return work;
    },
  } as unknown as AgentRuntimeInternal;

  await finishForegroundExecution.call(runtime, state, traceContext, async (delayMs) => {
    retryDelays.push(delayMs);
  });

  assert.equal(runtime.activeForegroundExecution, undefined);
  assert.equal(completeAttempts, 2);
  assert.equal(retainedWork.length, 1);
  assert.deepEqual(retryDelays, [1_000]);
  assert.deepEqual(warnings, [
    "Execution failover foreground target cleanup failed; retry scheduled",
  ]);
});
