import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEvent, TraceContext } from "@lcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import type { TaskNotificationRuntimeCommand } from "../command-queue.js";
import {
  enqueueBackgroundTaskNotification,
  persistBackgroundTaskNotificationBatch,
} from "./background-notifications.js";
import { InMemoryRuntimeTaskRegistry } from "../../runtime-task/registry.js";

function harness(failPersistence = false) {
  const events: SessionEvent[] = [];
  const queued: TaskNotificationRuntimeCommand[] = [];
  const order: string[] = [];
  const registry = new InMemoryRuntimeTaskRegistry();
  const runtime = {
    branchGeneration: 0,
    runtimeTaskRegistry: registry,
    ensureContextInitialized: async () => {},
    messageHistory: { addUser: () => {} },
    persistSyntheticUserNoticeForSession: async () => {
      if (failPersistence) throw new Error("test persistence failure");
      order.push("persisted");
    },
    createEvent: (type: SessionEvent["type"], payload: unknown) => ({ type, payload }),
    appendEvent: async (event: SessionEvent) => {
      events.push(event);
      order.push("consumed");
    },
    enqueueRuntimeCommand: (command: TaskNotificationRuntimeCommand) => queued.push(command),
  } as unknown as AgentRuntimeInternal;
  return { runtime, events, queued, order, registry };
}

function command(workId: string): TaskNotificationRuntimeCommand {
  return {
    id: `notification-${workId}` as TaskNotificationRuntimeCommand["id"],
    mode: "task-notification",
    priority: "next",
    source: "background_task",
    branchGeneration: 0,
    taskId: workId,
    taskLifecycleId: `life-${workId}`,
    text: "result",
    createdAt: new Date(),
    originMeta: { workId, backgroundSource: "subagent", title: "result" },
    traceContext: {} as TraceContext,
  } as TaskNotificationRuntimeCommand;
}

test("内联和批量共用入口：持久化后逐项发布准确的生命周期消费事实", async () => {
  const { runtime, events, order } = harness();
  const result = await persistBackgroundTaskNotificationBatch.call(
    runtime,
    [command("a"), command("b")],
    true,
  );
  assert.deepEqual(order, ["persisted", "consumed", "consumed"]);
  assert.deepEqual(
    events.map((event) => event.type),
    ["background_task_result_consumed", "background_task_result_consumed"],
  );
  assert.deepEqual(
    events.map((event) => event.payload),
    [
      {
        workId: "a",
        lifecycleId: "life-a",
        messageId: result.messageId,
        sourceCommandId: "notification-a",
        delivery: "activeLoop",
      },
      {
        workId: "b",
        lifecycleId: "life-b",
        messageId: result.messageId,
        sourceCommandId: "notification-b",
        delivery: "activeLoop",
      },
    ],
  );
});

test("outer-drain 使用 continuation 消费语义，等待新 turn 的原子投影", async () => {
  const { runtime, events } = harness();
  await persistBackgroundTaskNotificationBatch.call(runtime, [command("a"), command("b")]);
  assert.deepEqual(
    events.map((event) => (event.payload as { delivery: string }).delivery),
    ["continuation", "continuation"],
  );
});

test("通知持久化失败不伪造已消费事实", async () => {
  const { runtime, events } = harness(true);
  await assert.rejects(
    persistBackgroundTaskNotificationBatch.call(runtime, [command("a")]),
    /persistence failure/,
  );
  assert.deepEqual(events, []);
});

test("通知入队固定原执行代次，后续 resume 不得把旧结果改成新代", () => {
  const { runtime, queued, registry } = harness();
  registry.register({
    taskId: "a",
    agentId: "a",
    agentType: "Explore",
    type: "local_agent",
    description: "a",
    startedAt: new Date(),
    status: "completed",
  });
  enqueueBackgroundTaskNotification.call(runtime, {
    taskId: "a",
    text: "result",
    traceContext: {} as TraceContext,
  });
  const oldLife = registry.get("a")?.lifecycleId;
  assert.ok(oldLife);
  registry.register({
    taskId: "a",
    agentId: "a",
    agentType: "Explore",
    type: "local_agent",
    description: "a",
    startedAt: new Date(),
    status: "running",
  });
  assert.notEqual(registry.get("a")?.lifecycleId, oldLife);
  assert.equal(queued[0]?.taskLifecycleId, oldLife);
});
