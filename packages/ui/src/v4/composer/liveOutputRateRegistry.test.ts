import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { LiveOutputRateRegistry, observeLiveOutputRateStore } from "./liveOutputRateRegistry.js";

function liveSnapshot(
  sessionId: string,
  turnId: string,
  tokens: number,
  options: { phase?: string; responseId?: string; logEpoch?: string } = {},
): ConversationSnapshot {
  return {
    sessionId,
    logEpoch: options.logEpoch ?? "epoch-1",
    control: { phase: options.phase ?? "running" },
    rows: {
      window: [
        {
          kind: "assistantText",
          rowId: 1,
          turnId,
          assistantResponseId: options.responseId ?? "response-1",
          state: "streaming",
          text: "x".repeat(tokens * 3),
        },
      ],
    },
  } as ConversationSnapshot;
}

test("session switch retains only the matching active turn's last observed rate", () => {
  const rates = new LiveOutputRateRegistry();
  const a1 = liveSnapshot("a", "turn-a", 1);
  const a2 = liveSnapshot("a", "turn-a", 13);
  const b1 = liveSnapshot("b", "turn-b", 1);
  const b2 = liveSnapshot("b", "turn-b", 7);
  rates.observe(a1, 1_000);
  rates.observe(a2, 1_600);
  assert.equal(rates.read(a2), 20);
  rates.observe(b1, 1_700);
  rates.observe(b2, 2_300);
  assert.equal(rates.read(b2), 10);
  assert.equal(rates.read(a2), 20);

  const a3 = liveSnapshot("a", "turn-a", 25);
  rates.observe(a3, 2_500);
  assert.ok((rates.read(a3) ?? 0) > 0);
  assert.equal(rates.read(b2), 10);
  assert.equal(rates.read(liveSnapshot("a", "turn-next", 1)), null);
  assert.equal(rates.read(liveSnapshot("a", "turn-a", 1, { logEpoch: "epoch-2" })), null);
  assert.equal(rates.read(liveSnapshot("a", "turn-a", 25, { phase: "completedSuccess" })), null);
});

test("terminal, new turn and reconnect clear the previous run, not another session", () => {
  const rates = new LiveOutputRateRegistry();
  const a = liveSnapshot("a", "turn-a", 13);
  const b = liveSnapshot("b", "turn-b", 13);
  rates.observe(liveSnapshot("a", "turn-a", 1), 1_000);
  rates.observe(a, 1_600);
  rates.observe(liveSnapshot("b", "turn-b", 1), 1_000);
  rates.observe(b, 1_600);
  rates.observe(liveSnapshot("a", "turn-a", 13, { phase: "completedSuccess" }), 2_000);
  assert.equal(rates.read(a), null);
  assert.equal(rates.read(b), 20);

  rates.observe(liveSnapshot("b", "turn-next", 1), 2_100);
  assert.equal(rates.read(b), null);
  assert.equal(rates.read(liveSnapshot("b", "turn-next", 1)), null);
  rates.observe(liveSnapshot("b", "turn-next", 13), 2_700);
  assert.equal(rates.read(liveSnapshot("b", "turn-next", 13)), 20);
  rates.invalidate("b");
  assert.equal(rates.read(liveSnapshot("b", "turn-next", 13)), null);
});

test("offscreen gap keeps the last rate but starts a fresh measurement window", () => {
  const rates = new LiveOutputRateRegistry();
  rates.observe(liveSnapshot("a", "turn-a", 1), 1_000);
  rates.observe(liveSnapshot("a", "turn-a", 13), 1_600);
  rates.observe(liveSnapshot("a", "turn-a", 113), 11_000);
  assert.equal(rates.read(liveSnapshot("a", "turn-a", 113)), 20);
  rates.observe(liveSnapshot("a", "turn-a", 125), 11_600);
  assert.equal(rates.read(liveSnapshot("a", "turn-a", 125)), 20);
});

test("bounded session cache and subscribers do not turn terminal history into a rate", () => {
  const rates = new LiveOutputRateRegistry(2);
  let changes = 0;
  const unsubscribe = rates.subscribe(() => {
    changes += 1;
  });
  for (const id of ["a", "b", "c"]) {
    rates.observe(liveSnapshot(id, `turn-${id}`, 1), 1_000);
    rates.observe(liveSnapshot(id, `turn-${id}`, 13), 1_600);
  }
  assert.equal(rates.read(liveSnapshot("a", "turn-a", 13)), null);
  assert.equal(rates.read(liveSnapshot("c", "turn-c", 13)), 20);
  assert.ok(changes >= 3);
  unsubscribe();
  rates.clear();
  assert.equal(rates.read(liveSnapshot("c", "turn-c", 13)), null);
});

test("store observer ignores reconnect ACK's stale snapshot and resumes on the next frame", () => {
  const rates = new LiveOutputRateRegistry();
  const oldSnapshot = liveSnapshot("a", "turn-a", 13);
  rates.observe(liveSnapshot("a", "turn-a", 1), 1_000);
  rates.observe(oldSnapshot, 1_600);
  assert.equal(rates.read(oldSnapshot), 20);

  let state: { status: string; snapshot: ConversationSnapshot | null } = {
    status: "connecting",
    snapshot: null,
  };
  const listeners = new Set<() => void>();
  const stop = observeLiveOutputRateStore(
    {
      getState: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as never,
    rates,
    "a",
  );
  const publish = (status: string, snapshot: ConversationSnapshot) => {
    state = { status, snapshot };
    for (const listener of listeners) listener();
  };
  publish("live", oldSnapshot);
  publish("connecting", oldSnapshot);
  assert.equal(rates.read(oldSnapshot), null);
  publish("live", oldSnapshot);
  assert.equal(rates.read(oldSnapshot), null);
  publish("live", liveSnapshot("a", "turn-a", 25));
  assert.equal(rates.read(oldSnapshot), null);
  stop();
  publish("live", liveSnapshot("a", "turn-a", 37));
  assert.equal(rates.read(oldSnapshot), null);
});
