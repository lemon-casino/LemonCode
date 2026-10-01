import assert from "node:assert/strict";
import test from "node:test";
import type { MessageWithParts, SessionEvent } from "@lcode/contracts";
import { SessionEventType } from "@lcode/contracts";
import { applyConversationDeltas } from "@lcode/shared/lcode-protocol-v4";
import { ProductProjection } from "./product-projection.js";
import { mergeColdConversationEvents } from "./cold-event-merge.js";

const consumedType = SessionEventType.BackgroundTaskResultConsumed;

function event(sequenceNumber: number, type: SessionEvent["type"], payload: unknown): SessionEvent {
  return {
    id: `event-${sequenceNumber}` as SessionEvent["id"],
    sessionId: "session-1" as SessionEvent["sessionId"],
    turnId: "turn-1" as SessionEvent["turnId"],
    type,
    timestamp: new Date(sequenceNumber * 100),
    traceId: "trace-1" as SessionEvent["traceId"],
    sequenceNumber,
    payload,
  };
}

function start(
  sequenceNumber: number,
  taskId = "agent-1",
  taskKind = "subagent",
  lifecycleId = `life-${taskId}`,
): SessionEvent {
  return event(sequenceNumber, SessionEventType.BackgroundTaskStarted, {
    taskId,
    taskKind,
    lifecycleId,
    status: "running",
    description: taskId,
    cancellable: true,
  });
}

function complete(
  sequenceNumber: number,
  taskId = "agent-1",
  taskKind = "subagent",
  lifecycleId = `life-${taskId}`,
): SessionEvent {
  return event(sequenceNumber, SessionEventType.BackgroundTaskCompleted, {
    taskId,
    taskKind,
    lifecycleId,
    status: "completed",
    cancellable: false,
  });
}

function consume(
  sequenceNumber: number,
  workId = "agent-1",
  lifecycleId = `life-${workId}`,
): SessionEvent {
  return event(sequenceNumber, consumedType, {
    workId,
    lifecycleId,
    messageId: "msg-result",
    sourceCommandId: `notification-${workId}`,
    delivery: "activeLoop",
  });
}

test("内联消费后清除后台结果，continuous delta 与 replayable snapshot 一致", () => {
  const projection = new ProductProjection("session-1", "epoch-1");
  let desktopSnapshot = projection.getSnapshot();
  for (const fact of [start(1), complete(2), start(3, "preview", "bash"), consume(4)]) {
    const deltas = projection.applyEvent(fact);
    desktopSnapshot = applyConversationDeltas(desktopSnapshot, deltas);
  }
  assert.deepEqual(
    projection.getSnapshot().backgroundWorks.map((work) => work.workId),
    ["preview"],
  );
  assert.deepEqual(desktopSnapshot.backgroundWorks, projection.getSnapshot().backgroundWorks);
  const replay = new ProductProjection("session-1", "epoch-1");
  for (const fact of [start(1), complete(2), start(3, "preview", "bash"), consume(4)])
    replay.applyEvent(fact);
  assert.deepEqual(replay.getSnapshot().backgroundWorks, desktopSnapshot.backgroundWorks);
});

test("真实 atomic 发布保留消费侧表，拒绝候选不污染当前投影", () => {
  const projection = new ProductProjection("session-1", "epoch-1");
  projection.applyEventAtomically(start(1), () => true);
  projection.applyEventAtomically(complete(2), () => true);
  assert.equal(
    projection.applyEventAtomically(consume(3), () => false),
    null,
  );
  assert.equal(projection.getSnapshot().backgroundWorks[0]?.status, "resultPending");
  projection.applyEventAtomically(consume(3), () => true);
  projection.applyEventAtomically(complete(4), () => true);
  assert.deepEqual(projection.getSnapshot().backgroundWorks, []);
});

test("outer-drain 消费与 continuation 开始原子结算，不暴露可提前弹窗的完成态", () => {
  const projection = new ProductProjection("session-1", "epoch-1");
  for (const fact of [start(1), complete(2)]) projection.applyEventAtomically(fact, () => true);
  const consumed = consume(3);
  projection.applyEventAtomically(
    { ...consumed, payload: { ...(consumed.payload as object), delivery: "continuation" } },
    () => true,
  );
  assert.equal(projection.getSnapshot().backgroundWorks[0]?.status, "resultPending");
  projection.applyEventAtomically(
    event(4, SessionEventType.TurnStarted, {
      turnNumber: 2,
      input: "background result",
      messageId: "msg-result",
      inputSource: "background_task",
      inputVisibility: "model-only",
    }),
    () => true,
  );
  assert.deepEqual(projection.getSnapshot().backgroundWorks, []);
  assert.equal(projection.getSnapshot().control.phase, "running");
});

test("批量逐项消费不移除尚未消费的其他工作", () => {
  const projection = new ProductProjection("session-1", "epoch-1");
  for (const fact of [
    start(1),
    start(2, "workflow-1", "workflow"),
    start(3, "other"),
    complete(4),
    complete(5, "workflow-1", "workflow"),
    consume(6),
    consume(7, "workflow-1"),
  ])
    projection.applyEvent(fact);
  assert.deepEqual(
    projection.getSnapshot().backgroundWorks.map((work) => work.workId),
    ["other"],
  );
});

test("消费先于终态到达，迟到终态和重复消费不能复活 resultPending", () => {
  const projection = new ProductProjection("session-1", "epoch-1");
  for (const fact of [start(1), consume(2), complete(3), consume(4)]) projection.applyEvent(fact);
  assert.deepEqual(projection.getSnapshot().backgroundWorks, []);
});

for (const resumed of [false, true]) {
  test(`${resumed ? "SendMessage resume" : "workflow 重新启动"} 后旧消费不得移除新代`, () => {
    const projection = new ProductProjection("session-1", "epoch-1");
    for (const fact of [start(1), complete(2), consume(3)]) projection.applyEvent(fact);
    projection.applyEvent(
      resumed
        ? event(4, SessionEventType.SubagentSpawned, {
            agentId: "agent-1",
            lifecycleId: "life-new",
            childSessionId: "child-1",
            background: true,
            resumed: true,
            description: "resumed",
          })
        : start(4, "agent-1", "workflow", "life-new"),
    );
    projection.applyEvent(consume(5));
    assert.equal(projection.getSnapshot().backgroundWorks[0]?.status, "running");
    projection.applyEvent(complete(6, "agent-1", resumed ? "subagent" : "workflow", "life-new"));
    assert.equal(projection.getSnapshot().backgroundWorks[0]?.status, "resultPending");
    projection.applyEvent(consume(7, "agent-1", "life-new"));
    assert.deepEqual(projection.getSnapshot().backgroundWorks, []);
  });
}

test("冷合并保留消费事实，不在重连后重新挂出已消费任务", () => {
  const memoryEvents = [start(1), complete(2), consume(3)];
  const merged = mergeColdConversationEvents({
    sessionId: "session-1",
    memoryEvents,
    messages: [],
  });
  const projection = new ProductProjection("session-1", "epoch-1");
  for (const fact of merged.events) projection.applyEvent(fact);
  assert.deepEqual(projection.getSnapshot().backgroundWorks, []);
  assert.ok(
    !merged.diagnostics.some((item) => item.code === "cold_merge.unclassified_event_preserved"),
  );
});

test("无效消费载荷不得移除运行任务", () => {
  const projection = new ProductProjection("session-1", "epoch-1");
  projection.applyEvent(start(1));
  projection.applyEvent(event(2, consumedType, { workId: "agent-1", lifecycleId: "life-agent-1" }));
  assert.equal(projection.getSnapshot().backgroundWorks[0]?.status, "running");
});

test("带持久通知正文的冷合并在对应 continuation 起点恢复消费，不复活已结算 work", () => {
  const messages = [
    {
      info: {
        id: "msg-result",
        sessionID: "session-1",
        role: "user",
        time: { created: 300 },
        agent: "test",
        synthetic: true,
        source: "background_task",
        visibility: "model-only",
        metadata: { inputPresentation: "task_notification" },
        tools: {},
      },
      parts: [
        {
          id: "part-result",
          messageID: "msg-result",
          sessionID: "session-1",
          type: "text",
          text: "result",
          synthetic: true,
        },
      ],
    },
  ] as unknown as MessageWithParts[];
  const consumed = consume(3);
  const merged = mergeColdConversationEvents({
    sessionId: "session-1",
    messages,
    memoryEvents: [
      start(1),
      complete(2),
      { ...consumed, payload: { ...(consumed.payload as object), delivery: "continuation" } },
    ],
  });
  assert.ok(merged.events.some((event) => event.type === SessionEventType.TurnStarted));
  const projection = new ProductProjection("session-1", "epoch-1");
  projection.beginHydrationReplay();
  for (const event of merged.events) projection.applyEvent(event);
  projection.completeHydrationReplay();
  assert.deepEqual(projection.getSnapshot().backgroundWorks, []);
});
