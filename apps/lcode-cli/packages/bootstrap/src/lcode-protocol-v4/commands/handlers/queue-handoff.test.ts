import assert from "node:assert/strict";
import test from "node:test";
import type { QueueItem, CommandEnvelope } from "@lcode/shared/lcode-protocol-v4";
import type { V4CommandCoreHost, V4SessionRecordView } from "../types.js";
import { V4CommandExecutor } from "../executor.js";

const selection = {
  providerId: "new-provider",
  modelId: "new-model",
  options: { reasoningLevel: "max", speed: "fast" },
};

function fixture(failStart = false, finalizationDelayMs = 0) {
  let foregroundId: string | undefined = "old-execution";
  let coreStopped = false;
  let foregroundIdle = false;
  let reserved = false;
  let removed = false;
  let released = false;
  let starts = 0;
  let receivedIntent: unknown;
  const controller = new AbortController();
  const item: QueueItem = {
    queueItemId: "queue-original",
    sourceCommandId: "original",
    clientId: "client",
    kind: "sendText",
    text: "replace avatar",
    attachments: [],
    modelSelection: selection,
    order: { admissionSeq: 1, queuePosition: 0 },
    delivery: { requested: "queue", admitted: "queue" },
    steer: { state: "notRequested" },
    dispatch: { state: "queued" },
    admittedAt: 1,
  };
  const record = {
    workspace: { workspacePath: "/fixture" },
    traceContext: { traceId: "trace-queue" },
    persistence: "immediate",
    activeAbortController: controller,
    app: {
      sessionId: "session",
      readTarget: async () => null,
      runtime: {
        acquireForegroundPromotionLease: () => ({ kind: "acquired" }),
        releaseForegroundPromotionLease: () => {
          released = true;
          return true;
        },
        stopActiveForegroundExecution: () => {
          coreStopped = true;
          return { kind: "stopped", foregroundExecutionId: foregroundId };
        },
        getActiveForegroundExecutionId: () => foregroundId,
        isForegroundExecutionIdleForPromotion: () => foregroundIdle,
      },
      reserveQueueItem: async () => {
        reserved = true;
        return true;
      },
      releaseQueueItemReservation: async () => {
        reserved = false;
        return true;
      },
      markQueueItemPromoting: async () => true,
      removeQueueItem: async () => {
        removed = true;
        return true;
      },
      sendInput: async (_input: unknown, options: { intent?: unknown; inputId?: string }) => {
        assert.equal(record.activeAbortController, undefined);
        assert.equal(foregroundId, undefined);
        assert.equal(foregroundIdle, true);
        assert.equal(options.inputId, item.sourceCommandId);
        receivedIntent = options.intent;
        starts += 1;
        if (failStart) throw new Error("new model unavailable");
        return { kind: "started_turn", turnId: "new-turn", completion: Promise.resolve() };
      },
    },
  } as unknown as V4SessionRecordView;
  // 外层操作还持有自己的取消域；只有两层都取消，真实 finally 才能完成交接。
  controller.signal.addEventListener(
    "abort",
    () => {
      assert.equal(coreStopped, true);
      foregroundId = undefined;
      record.activeAbortController = undefined;
      if (finalizationDelayMs > 0) {
        setTimeout(() => {
          foregroundIdle = true;
        }, finalizationDelayMs);
      } else {
        foregroundIdle = true;
      }
    },
    { once: true },
  );
  const host = {
    getRecord: () => record,
    getQueueItem: () => item,
  } as V4CommandCoreHost;
  const envelope: CommandEnvelope = {
    type: "sendQueuedNow",
    commandId: "promotion",
    clientId: "client",
    sessionId: "session",
    payload: { queueItemId: item.queueItemId },
    issuedAt: 1,
  };
  return { host, envelope, state: () => ({ reserved, removed, released, starts, receivedIntent }) };
}

test("sendQueuedNow cancels both owners and preserves the queued new model selection", async () => {
  const f = fixture();
  await new V4CommandExecutor(f.host).execute(f.envelope);
  assert.equal(f.state().starts, 1);
  assert.equal(f.state().removed, true);
  assert.equal(f.state().released, true);
  assert.deepEqual(
    (f.state().receivedIntent as { modelSelection: unknown }).modelSelection,
    selection,
  );
});

test("failed handoff keeps the original queue item and releases reservation and lease", async () => {
  const f = fixture(true);
  await assert.rejects(new V4CommandExecutor(f.host).execute(f.envelope), /new model unavailable/);
  assert.equal(f.state().removed, false);
  assert.equal(f.state().reserved, false);
  assert.equal(f.state().released, true);
});

test("handoff waits for Core finalization after both cancellation owners release", async () => {
  const f = fixture(false, 40);
  await new V4CommandExecutor(f.host).execute(f.envelope);
  assert.equal(f.state().starts, 1);
  assert.equal(f.state().removed, true);
});
