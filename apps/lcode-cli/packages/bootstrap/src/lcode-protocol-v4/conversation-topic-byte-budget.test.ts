import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@lcode/contracts";
import {
  PROTOCOL_V4_LIMITS,
  coalesceConversationDeltas,
  utf8JsonByteLength,
  type ConversationDelta,
  type ConversationSnapshot,
  type WorkflowRunsState,
} from "@lcode/shared/lcode-protocol-v4";
import {
  appendConversationSubscriberBuffer,
  PROJECTION_TERMINAL_RESERVE_BYTES,
  ProjectionPayloadTooLargeError,
} from "./conversation-topic-buffer.js";
import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";
import { measureWireSnapshotBytes } from "./conversation-topic-queries.js";
import { ProductProjection } from "./product-projection.js";

const sessionId = "byte-session";
const logEpoch = "byte-epoch";
const topic = `conversation/${sessionId}`;
const wireContext = { logEpoch, topic };
const instance = { siteId: "ask#one", ordinal: 1 };

function facts() {
  let sequence = 0;
  const events: SessionEvent[] = [];
  const event = (type: SessionEvent["type"], payload: unknown): SessionEvent => {
    const value = {
      id: `event-${++sequence}`,
      sessionId,
      traceId: "byte-trace",
      type,
      sequenceNumber: sequence,
      timestamp: new Date(sequence),
      payload,
    } as SessionEvent;
    events.push(value);
    return value;
  };
  return {
    events,
    event,
    workflow(eventType: string, payload: Record<string, unknown> = {}) {
      return event(SessionEventType.DynamicWorkflowRunProgress, {
        runId: "byte-run",
        sequence: sequence + 1,
        occurredAt: sequence + 1,
        eventType,
        payload,
      });
    },
  };
}

function activity(observedAt: number, requestId = "request-one") {
  return { kind: "model", observedAt, since: 1, requestsCompleted: 0, toolCalls: 0, requestId };
}

function projectedFixture(count = 3, text = '调查"\\\n\t\u0000\ud83d\ude80\ud800\udfff') {
  const projection = new ProductProjection(sessionId, logEpoch);
  const source = facts();
  projection.applyEvent(source.workflow("run-started"));
  for (let ordinal = 1; ordinal <= count; ordinal++) {
    projection.applyEvent(
      source.workflow("actor-created", {
        actor: { siteId: "actor#one", ordinal },
        name: `${ordinal}-${text}`,
      }),
    );
    projection.applyEvent(
      source.workflow("node-queued", {
        instance: { siteId: "ask#one", ordinal },
        actor: { siteId: "actor#one", ordinal },
        kind: "ask",
        instructionsHead: text.repeat(2),
      }),
    );
  }
  return { projection, source };
}

function snapshotBytes(snapshot: ConversationSnapshot): number {
  return utf8JsonByteLength({
    topic,
    subscriptionId: `sub-${logEpoch}-${Number.MAX_SAFE_INTEGER}`,
    fromSeq: 0,
    toSeq: snapshot.seq,
    sentAt: Number.MAX_SAFE_INTEGER,
    payload: { kind: "snapshot", snapshot },
  });
}

function stateDelta(
  workflowRuns: WorkflowRunsState,
): Extract<ConversationDelta, { op: "state.updated" }> {
  return { op: "state.updated", patch: { workflowRuns } };
}

function checkBuffer(current: ConversationDelta[], incoming: ConversationDelta[]) {
  const expected = coalesceConversationDeltas([...current, ...incoming]);
  const bytes = utf8JsonByteLength({ kind: "deltas", deltas: expected });
  const before = JSON.stringify([current, incoming]);
  const result = appendConversationSubscriberBuffer(current, incoming, { maxBytes: bytes });
  assert.equal(result.kind, "buffered");
  if (result.kind !== "buffered") return;
  assert.deepEqual(result.deltas, expected);
  assert.equal(result.encodedBytes, bytes);
  assert.notStrictEqual(result.deltas, current);
  assert.equal(JSON.stringify([current, incoming]), before);
  assert.deepEqual(appendConversationSubscriberBuffer(current, incoming, { maxBytes: bytes - 1 }), {
    kind: "overflow",
  });
  return result;
}

test("workflow snapshot/delta 字节逐值等同原 JSON，包含 Unicode、孤立代理项、转义和 undefined", () => {
  const { projection, source } = projectedFixture();
  for (const requestId of [
    "ascii",
    "中文",
    "\ud83d\ude80",
    "\ud800",
    "\udfff",
    '"\\\n\r\t\u0000',
  ]) {
    projection.applyEvent(
      source.workflow("node-activity", {
        instance,
        activity: { ...activity(source.events.length + 1, requestId), toolName: undefined },
      }),
    );
    const snapshot = projection.getSnapshot();
    assert.equal(measureWireSnapshotBytes(wireContext, snapshot), snapshotBytes(snapshot));
    const patch = stateDelta(snapshot.workflowRuns!);
    checkBuffer([], [patch]);
    checkBuffer([patch], [{ op: "state.updated", patch: { revision: 10, plan: null } }, patch]);
    checkBuffer([patch, { op: "row.removed", fromRowId: 1 }], [patch]);
  }
});

test("重复嵌套的同一 workflow 引用逐次计量，未知 toJSON 仍接收原 key", () => {
  const { projection } = projectedFixture();
  const state = projection.getSnapshot().workflowRuns!;
  const keys: string[] = [];
  const opaque = {
    toJSON(key: string) {
      keys.push(key);
      return { label: `未知-${key}`, state, missing: undefined, list: [undefined, null, state] };
    },
  };
  const incoming: ConversationDelta[] = [
    {
      op: "state.updated",
      patch: Object.assign(
        { workflowRuns: state },
        { future: { state, copies: [state, { state }], opaque } },
      ),
    },
  ];
  checkBuffer([], incoming);
  assert.ok(keys.length > 0);
  assert.ok(keys.every((key) => key === "opaque"));
  const cloned = structuredClone(state);
  const mutable = Object.assign(stateDelta(cloned).patch, { future: { value: "before" } });
  checkBuffer([], [{ op: "state.updated", patch: mutable }]);
  cloned.runs[0]!.nodes[0]!.instructionsHead = "变化后\ud83d\ude80\n";
  mutable.future.value = "after-after";
  checkBuffer([], [{ op: "state.updated", patch: mutable }]);
});

test("未登记 JSON 值仍逐次序列化，循环和 BigInt 不被缓存绕过", () => {
  let value = "one";
  const foreign = { toJSON: (key: string) => `${key}:${value}` };
  const patch = Object.assign(
    { revision: 1 },
    { future: foreign, missing: undefined, values: [undefined, NaN, Infinity] },
  );
  checkBuffer([], [{ op: "state.updated", patch }]);
  value = "two 中文\ud800";
  checkBuffer([], [{ op: "state.updated", patch }]);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const future of [cycle, 1n]) {
    assert.throws(
      () =>
        appendConversationSubscriberBuffer(
          [],
          [
            {
              op: "state.updated",
              patch: Object.assign({ revision: 1 }, { future }),
            },
          ],
        ),
      TypeError,
    );
  }
});

test("外部 seed 的 mutable workflow 经 reducer 浅拷贝后仍不能登记为 owner 字节缓存", () => {
  const projection = new ProductProjection(sessionId, logEpoch);
  const source = facts();
  const seed = structuredClone(projectedFixture().projection.getSnapshot().workflowRuns!);
  Object.assign(projection.getSnapshot(), { workflowRuns: seed });
  for (let index = 0; index <= seed.runs[0]!.lastEventSequence; index++) {
    projection.applyEvent(source.workflow("usage-updated", { spentTokens: index }));
  }
  const current = projection.getSnapshot();
  const before = measureWireSnapshotBytes(wireContext, current);
  assert.equal(before, snapshotBytes(current));
  seed.runs[0]!.nodes[0]!.instructionsHead = "外部修改后的新值";
  assert.notEqual(snapshotBytes(current), before);
  assert.equal(measureWireSnapshotBytes(wireContext, current), snapshotBytes(current));
});

test("bridge 搬运的非标准 identity 保持 mutable/toJSON 的原序列化语义", () => {
  const source = facts();
  const projection = new ProductProjection(sessionId, logEpoch);
  let label = "first";
  const identity = { toJSON: (key: string) => `${key}-${label}` };
  const event = source.workflow("run-started");
  Object.assign(event.payload as object, { toolCallId: identity });
  projection.applyEvent(event);
  const snapshot = projection.getSnapshot();
  const before = measureWireSnapshotBytes(wireContext, snapshot);
  assert.equal(before, snapshotBytes(snapshot));
  label = "改变后";
  assert.notEqual(snapshotBytes(snapshot), before);
  assert.equal(measureWireSnapshotBytes(wireContext, snapshot), snapshotBytes(snapshot));
});

test("workflow 之外的对象自有 toJSON、undefined、日期和稀疏数组沿原路径计量", () => {
  const { projection } = projectedFixture();
  const snapshot = projection.getSnapshot();
  const keys: string[] = [];
  const changed = {
    ...snapshot,
    toJSON(key: string) {
      keys.push(key);
      return {
        state: snapshot.workflowRuns,
        omitted: undefined,
        now: new Date(0),
        sparse: Object.assign([], { length: 3 }),
      };
    },
  };
  assert.equal(measureWireSnapshotBytes(wireContext, changed), snapshotBytes(changed));
  assert.deepEqual(keys, ["snapshot", "snapshot"]);
});

test("coalesce 保持行屏障、追加吞并、状态浅覆盖与 op 上限", () => {
  const { projection } = projectedFixture();
  const workflow = stateDelta(projection.getSnapshot().workflowRuns!);
  const current: ConversationDelta[] = [
    workflow,
    { op: "row.delta", rowId: 1, path: "text", append: "第一段" },
  ];
  checkBuffer(current, [
    { op: "row.delta", rowId: 1, path: "text", append: "第二段" },
    { op: "row.removed", fromRowId: 2 },
    workflow,
    { op: "state.updated", patch: { workflowRuns: undefined, revision: 9 } },
  ]);
  assert.deepEqual(appendConversationSubscriberBuffer([], [workflow], { maxOps: 0 }), {
    kind: "overflow",
  });
});

test("已由 owner 归约的不可变 workflow 子树不被每订阅或 snapshot 重复整树序列化", (t) => {
  const { projection, source } = projectedFixture(64, "节点信息".repeat(20));
  const snapshot = projection.getSnapshot();
  const expected = snapshotBytes(snapshot);
  const stringify = JSON.stringify;
  let largestSerializedBytes = 0;
  t.mock.method(JSON, "stringify", (...args: Parameters<typeof stringify>) => {
    const serialized = stringify(...args);
    largestSerializedBytes = Math.max(largestSerializedBytes, Buffer.byteLength(serialized ?? ""));
    return serialized;
  });
  assert.equal(measureWireSnapshotBytes(wireContext, snapshot), expected);
  for (let index = 0; index < 2; index++) {
    const result = appendConversationSubscriberBuffer([], [stateDelta(snapshot.workflowRuns!)]);
    assert.equal(result.kind, "buffered");
  }
  projection.applyEvent(source.workflow("node-activity", { instance, activity: activity(1_000) }));
  measureWireSnapshotBytes(wireContext, projection.getSnapshot());
  assert.ok(expected > 30_000);
  // 结构性成本断言，不用耗时阈值；只序列化包装和新节点，不重新输出其余 63 个节点。
  assert.ok(largestSerializedBytes < 4_000, `serialized ${largestSerializedBytes} bytes`);
});

test("拒绝原子 workflow candidate 后旧 snapshot 及其字节保持不变", () => {
  const { projection, source } = projectedFixture();
  const original = projection.getSnapshot();
  const before = structuredClone(original);
  const bytes = measureWireSnapshotBytes(wireContext, original);
  const event = source.workflow("node-activity", {
    instance,
    activity: activity(9_999, "更长的请求"),
  });
  let candidateBytes = 0;
  assert.equal(
    projection.applyEventAtomically(event, (candidate) => {
      candidateBytes = measureWireSnapshotBytes(wireContext, candidate);
      assert.equal(candidateBytes, snapshotBytes(candidate));
      return false;
    }),
    null,
  );
  assert.strictEqual(projection.getSnapshot(), original);
  assert.deepEqual(original, before);
  assert.equal(measureWireSnapshotBytes(wireContext, original), bytes);
  assert.notEqual(candidateBytes, bytes);
  assert.notEqual(
    projection.applyEventAtomically(
      event,
      (candidate) => measureWireSnapshotBytes(wireContext, candidate) <= candidateBytes,
    ),
    null,
  );
  assert.equal(measureWireSnapshotBytes(wireContext, projection.getSnapshot()), candidateBytes);
  assert.equal(measureWireSnapshotBytes(wireContext, original), bytes);
});

for (const deliveryProfile of ["continuous", "replayable"] as const) {
  test(`${deliveryProfile}: buffer drain/recovery/rollback/rebase 不复用另一版本的字节`, () => {
    const publisher = new ConversationTopicPublisher(sessionId, logEpoch);
    const source = facts();
    const initial = publisher.subscribeReserved({ connectionId: "one", deliveryProfile });
    assert.equal(initial.reservation?.commit(), true);
    const subscriptionId = initial.ack.subscriptionId;
    publisher.ingest(source.workflow("run-started"));
    publisher.ingest(source.workflow("node-queued", { instance, kind: "ask" }));
    publisher.ingest(source.workflow("node-activity", { instance, activity: activity(10) }));
    const old = publisher.reserveFlush(subscriptionId)!;
    const oldJson = JSON.stringify(old.frame);
    publisher.ingest(
      source.workflow("node-activity", { instance, activity: activity(20, "第二次请求") }),
    );
    assert.strictEqual(publisher.reserveFlush(subscriptionId), old);
    assert.equal(JSON.stringify(old.frame), oldJson);
    assert.equal(old.commit(), true);
    const pending = publisher.reserveFlush(subscriptionId)!;
    assert.equal(pending.frame.fromSeq, old.frame.toSeq);
    const pendingJson = JSON.stringify(pending.frame);
    const recovery = publisher.resyncReserved(subscriptionId, {
      base: { logEpoch, seq: old.frame.toSeq },
      forceSnapshot: deliveryProfile === "continuous",
    })!;
    assert.equal(pending.commit(), false);
    publisher.ingest(
      source.workflow("node-activity", { instance, activity: activity(30, "第三次请求\n") }),
    );
    assert.equal(recovery.rollback(), true);
    assert.equal(recovery.reservation?.commit(), false);
    assert.equal(JSON.stringify(pending.frame), pendingJson);
    assert.equal(pending.commit(), true);
    const latest = publisher.reserveFlush(subscriptionId)!;
    assert.equal(latest.frame.fromSeq, pending.frame.toSeq);
    assert.equal(latest.frame.toSeq, publisher.getSnapshot().seq);
    assert.equal(publisher.getWireSnapshotLogicalBytes(), snapshotBytes(publisher.getSnapshot()));
    publisher.rehydrate(source.events.slice(0, 3));
    assert.equal(latest.commit(), false);
    assert.equal(publisher.hasSubscription(subscriptionId, "one"), true);
    const rebased = publisher.reserveFlush(subscriptionId)!;
    assert.equal(rebased.frame.payload.kind, "snapshot");
    assert.equal(publisher.getWireSnapshotLogicalBytes(), snapshotBytes(publisher.getSnapshot()));
    publisher.unsubscribe(subscriptionId);
    assert.equal(rebased.commit(), false);
    assert.equal(publisher.hasSubscribers(), false);
    const reopened = publisher.subscribeReserved({ connectionId: "one", deliveryProfile });
    assert.notEqual(reopened.ack.subscriptionId, subscriptionId);
    assert.equal(reopened.reservation?.commit(), true);
    publisher.unsubscribe(reopened.ack.subscriptionId);
  });

  test(`${deliveryProfile}: byte 边界溢出仍丢弃 buffer 并保持 snapshot 恢复`, () => {
    const reference = new ProductProjection(sessionId, logEpoch);
    const source = facts();
    const event = source.workflow("run-started");
    const deltas = reference.applyEvent(event);
    const limit = utf8JsonByteLength({ kind: "deltas", deltas });
    for (const maxBytes of [limit, limit - 1]) {
      const publisher = new ConversationTopicPublisher(sessionId, logEpoch, {
        subscriberBufferMaxBytes: maxBytes,
      });
      const subscribed = publisher.subscribe({ connectionId: "one", deliveryProfile });
      publisher.ingest(event);
      const reserved = publisher.reserveFlush(subscribed.ack.subscriptionId)!;
      assert.equal(reserved.frame.payload.kind, maxBytes === limit ? "deltas" : "snapshot");
      assert.equal(reserved.commit(), true);
      assert.equal(publisher.reserveFlush(subscribed.ack.subscriptionId), null);
      publisher.unsubscribe(subscribed.ack.subscriptionId);
    }
  });
}

test("snapshot 严格上限两侧保持 candidate 原子接受与拒绝、terminal reserve 和旧 reservation", () => {
  const publisher = new ConversationTopicPublisher(sessionId, logEpoch);
  const source = facts();
  const initial = publisher.subscribe({ connectionId: "one", deliveryProfile: "continuous" });
  publisher.ingest(source.workflow("run-started"));
  const limit = PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes - PROJECTION_TERMINAL_RESERVE_BYTES;
  const emptyCandidate = {
    ...publisher.getSnapshot(),
    seq: 2,
    revision: 1,
    meta: { title: "", titleSource: "custom" as const },
  };
  const title = "x".repeat(limit - snapshotBytes(emptyCandidate));
  publisher.ingest(source.event(SessionEventType.SessionTitleUpdated, { title, source: "custom" }));
  const accepted = publisher.getSnapshot();
  assert.equal(publisher.getWireSnapshotLogicalBytes(), limit);
  const reservation = publisher.reserveFlush(initial.ack.subscriptionId)!;
  assert.throws(
    () =>
      publisher.ingest(
        source.event(SessionEventType.SessionTitleUpdated, {
          title: `${title}x`,
          source: "custom",
        }),
      ),
    (error: unknown) =>
      error instanceof ProjectionPayloadTooLargeError && error.logicalBytes === limit + 1,
  );
  assert.strictEqual(publisher.getSnapshot(), accepted);
  assert.equal(publisher.getWireSnapshotLogicalBytes(), limit);
  assert.equal(reservation.commit(), true);
  publisher.unsubscribe(initial.ack.subscriptionId);
});
