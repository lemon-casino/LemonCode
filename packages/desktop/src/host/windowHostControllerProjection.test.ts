// 回归测试：Controller 投影必须把 sessions-index 的执行绑定透传到 task row。
// 覆盖原缺陷：tasks-index 不持久化 executionBindingId，覆盖层此前也不下发，
// 导致侧栏「工作树」分类在 Controller 视图（时间线/工作树）读不到绑定而漏显。
import assert from "node:assert/strict";
import test from "node:test";
import { createWindowHostControllerProjection } from "./windowHostControllerProjection.js";

const scope = { kind: "local" as const, workspacePath: "E:/repo" };

function createProjection() {
  let nextId = 0;
  const projection = createWindowHostControllerProjection({
    createId: () => `id-${(nextId += 1)}`,
  });
  projection.registerSource({ scope, mutate: () => undefined });
  return projection;
}

const baseMeta = {
  taskId: "root",
  traceId: "trace-root",
  title: "hi",
  workspacePath: "E:/repo",
  createdAt: 1,
  updatedAt: 1,
  mode: "build" as const,
};

test("session overlay carries the execution binding into task rows", () => {
  const projection = createProjection();
  projection.replaceSourceSnapshot({
    scope,
    taskIndex: [{ meta: baseMeta, membership: { pinned: false, archived: false, active: true } }],
    sessionsIndex: [
      {
        taskId: "root",
        liveStatus: "completed",
        executionBindingId: "binding-1",
      },
    ],
  });

  const [row] = projection.getTasks();
  assert.equal(row?.meta.executionBindingId, "binding-1");
});

test("a session without an execution binding clears a stale one", () => {
  const projection = createProjection();
  projection.replaceSourceSnapshot({
    scope,
    taskIndex: [
      {
        // 模拟旧投影里残留的绑定；覆盖层缺席时必须清掉，否则会话换回本地目录后
        // 仍会留在「工作树」分类里。
        meta: { ...baseMeta, executionBindingId: "stale-binding" },
        membership: { pinned: false, archived: false, active: true },
      },
    ],
    sessionsIndex: [{ taskId: "root", liveStatus: "idle" }],
  });

  const [row] = projection.getTasks();
  assert.equal(row?.meta.executionBindingId, undefined);
});

test("replaceSourceSessionOverlays keeps the binding on live frames", () => {
  const projection = createProjection();
  projection.replaceSourceSnapshot({
    scope,
    taskIndex: [{ meta: baseMeta, membership: { pinned: false, archived: false, active: true } }],
    sessionsIndex: [],
  });
  assert.equal(projection.getTasks()[0]?.meta.executionBindingId, undefined);

  projection.replaceSourceSessionOverlays(scope, [
    { taskId: "root", liveStatus: "running", executionBindingId: "binding-1" },
  ]);
  assert.equal(projection.getTasks()[0]?.meta.executionBindingId, "binding-1");
});
