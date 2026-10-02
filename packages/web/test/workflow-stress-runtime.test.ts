import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import {
  type ConversationTopicFrame,
  type WorkflowRunsState,
} from "@lcode/shared/lcode-protocol-v4";
import { BrowserStressController } from "./fixtures/workflow-stress-runtime.js";
import { StressBrowserMetrics } from "./fixtures/workflow-stress-metrics.js";

/** Unit-only platform hooks; these tests make no browser/render-performance claim. */
function installPlatform(t: TestContext) {
  const values = {
    window: new EventTarget(),
    requestAnimationFrame: (_callback: FrameRequestCallback) => 1,
    cancelAnimationFrame: (_handle: number) => {},
    __LCODE_RENDERER_DISABLE_LOGGING__: true,
  };
  const previous = Object.keys(values).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
}

function frameFacts(frame: ConversationTopicFrame): WorkflowRunsState {
  const facts =
    frame.payload.kind === "snapshot"
      ? frame.payload.snapshot.workflowRuns
      : frame.payload.deltas.find((delta) => delta.op === "state.updated")?.patch.workflowRuns;
  assert.ok(facts);
  return facts;
}

async function recover(controller: BrowserStressController) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      unsubscribe = controller.store.subscribe(() => {
        if (!controller.store.getState().syncing && controller.result().recoveries === 1) resolve();
      });
      // Watchdog only: completion is the actual store notification, not an arbitrary drain delay.
      timer = setTimeout(() => reject(new Error("recovery did not finish")), 2_000);
      controller.recover();
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe?.();
  }
}

function assertClosed(controller: BrowserStressController) {
  const value = controller.result();
  assert.equal(value.storeStatus, "closed");
  assert.equal(value.storeSyncing, false);
  assert.equal(value.subscriptionsRemaining, 0);
  assert.equal(value.transportListenersRemaining, 0);
  assert.equal(value.sourceTimersRemaining, 0);
  assert.equal(value.recoveryTimersRemaining, 0);
  assert.equal(value.rafRemaining, 0);
  assert.equal(value.errorListenersRemaining, 0);
}

for (const profile of ["desktop-continuous", "web-remote-replayable"] as const) {
  test(`${profile}: actual recovery compares normalized facts, not key insertion order`, async (t) => {
    installPlatform(t);
    const controller = new BrowserStressController(12, profile, 10_000);
    const handle = controller.store.handleFrame.bind(controller.store);
    let recoveredFrame = false;
    controller.store.handleFrame = (frame, delivery) => {
      handle(frame, delivery);
      if (delivery?.deliveryKind !== "recovery") return;
      recoveredFrame = true;
      assert.equal(controller.store.getState().snapshot?.seq, frame.toSeq);
      assert.deepEqual(controller.store.getState().snapshot?.workflowRuns, frameFacts(frame));
      assert.equal(
        controller.store.getState().syncing,
        true,
        "facts apply synchronously before ACK continuation",
      );
    };
    try {
      await controller.start();
      const subscription = controller.store.getState().subscriptionId;
      await recover(controller);
      assert.equal(recoveredFrame, true);
      assert.equal(controller.store.getState().subscriptionId, subscription);
      assert.equal(controller.result().recoveries, 1);
      assert.equal(controller.result().recoveryConsistencyFailures, 0);
      assert.equal(controller.result().storeSyncing, false);
      const before = controller.store.getState().snapshot;
      controller.stale();
      assert.equal(controller.store.getState().snapshot, before);
      assert.equal(controller.result().staleChecks, 1);
      assert.equal(controller.result().recoveryConsistencyFailures, 0);
      await controller.stop();
      const stopped = controller.result();
      await sleep(15);
      await controller.stop();
      assert.deepEqual(
        controller.result(),
        stopped,
        "queries and duplicate stop do not extend measurement",
      );
      assertClosed(controller);
    } finally {
      await controller.stop();
    }
  });

  for (const mutation of ["value", "missing-field", "array-order"] as const) {
    test(`${profile}: recovery still rejects a changed ${mutation}`, async (t) => {
      installPlatform(t);
      const controller = new BrowserStressController(12, profile, 10_000);
      const handle = controller.store.handleFrame.bind(controller.store);
      controller.store.handleFrame = (frame, delivery) => {
        if (delivery?.deliveryKind !== "recovery") return handle(frame, delivery);
        const wrong = structuredClone(frame);
        const run = frameFacts(wrong).runs[0]!;
        if (mutation === "value") run.usage.spentTokens++;
        if (mutation === "missing-field") delete run.truncated;
        if (mutation === "array-order") run.actors.reverse();
        handle(wrong, delivery);
      };
      try {
        await controller.start();
        await recover(controller);
        assert.equal(controller.result().recoveries, 1);
        assert.equal(controller.result().recoveryConsistencyFailures, 1);
        assert.equal(controller.result().storeSyncing, false);
      } finally {
        await controller.stop();
        assertClosed(controller);
      }
    });
  }
}

test("metric clock freezes after stop; RAF interval coverage preserves unobserved endpoints", (t) => {
  installPlatform(t);
  let now = 1_000;
  t.mock.method(performance, "now", () => now);
  let pending: FrameRequestCallback | undefined;
  t.mock.method(globalThis, "requestAnimationFrame", (callback: FrameRequestCallback) => {
    pending = callback;
    return 1;
  });
  t.mock.method(globalThis, "cancelAnimationFrame", () => {
    pending = undefined;
  });
  const metrics = new StressBrowserMetrics();
  metrics.start();
  now = 1_018;
  pending?.(1_016);
  now = 1_034;
  pending?.(1_032);
  now = 1_100;
  metrics.stop();
  const stopped = metrics.result();
  assert.equal(stopped.measuredWallMs, 100);
  assert.equal(stopped.raf.totalMs, 16);
  const coverage = stopped.rafCoverage;
  assert.ok(coverage);
  assert.equal(coverage.firstFrameOffsetMs, 16);
  assert.equal(coverage.lastFrameOffsetMs, 32);
  assert.equal(coverage.beforeFirstFrameMs, 16);
  assert.equal(coverage.afterLastFrameMs, 68);
  assert.equal(coverage.intervalCoveredMs, 16);
  assert.equal(coverage.unobservedEndpointMs, 84);
  assert.equal(
    coverage.unobservedEndpointMs,
    coverage.beforeFirstFrameMs! + coverage.afterLastFrameMs!,
  );
  now = 2_000;
  metrics.stop();
  metrics.onRender("fixture", "update", 123, 0, 0, 0);
  window.dispatchEvent(new Event("error"));
  assert.deepEqual(metrics.result(), stopped);
  assert.equal(pending, undefined);
});
