import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  buildRemoteWorkspaceIdentity,
  lcodeSessionStateSnapshotSchema,
  LCODE_PROTOCOL_NAME,
  LCODE_PROTOCOL_VERSION,
  resolveWorktreeProjectScope,
  type LCodeTaskMeta,
  type LCodeWorkspaceEvent,
} from "@lcode/shared";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { createLCodeTaskIndexSyncer } from "./lcodeTaskIndexSyncer.js";
import { createLCodeTaskServiceAdapter } from "./lcodeTaskServiceAdapter.js";
import type { ILCodeAgentService } from "./lcodeAgent.js";

const source = { workspacePath: "/checkouts/task" };
const origin = { workspacePath: "/project" };
const workspace = {
  ...source,
  executionBindingId: "binding",
  originWorkspacePath: origin.workspacePath,
};
const meta: LCodeTaskMeta = {
  ...source,
  taskId: "session",
  traceId: "trace",
  title: "用户改过的标题",
  provider: "glm",
  mode: "build",
  status: "completed",
  unreadAt: 7,
  createdAt: 1,
  updatedAt: 2,
};

test("项目归属只使用已绑定的来源，独立保留远端 identity", () => {
  assert.deepEqual(resolveWorktreeProjectScope(workspace), origin);
  assert.deepEqual(
    resolveWorktreeProjectScope({ ...source, originWorkspacePath: "/other" }),
    source,
  );
  const target = { kind: "docker", container: "fixture-host" } as const;
  const workspaceIdentity = buildRemoteWorkspaceIdentity(source.workspacePath, target);
  const originWorkspaceIdentity = buildRemoteWorkspaceIdentity(origin.workspacePath, target);
  assert.deepEqual(
    resolveWorktreeProjectScope({ ...workspace, workspaceIdentity, originWorkspaceIdentity }),
    { ...origin, workspaceIdentity: originWorkspaceIdentity },
  );
  // 本地来源没有 identity 时，不能借用工作树的执行 identity 当项目身份。
  assert.deepEqual(resolveWorktreeProjectScope({ ...workspace, workspaceIdentity }), origin);
});

test("旧工作树索引迁回原项目，保留产品状态、分组和顺序且幂等", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lcode-worktree-index-"));
  const path = join(dir, "tasks.sqlite");
  const repo = new TaskIndexRepo(path);
  let db: DatabaseSync | undefined;
  try {
    await repo.syncTaskMeta({
      meta,
      pinned: true,
      archived: true,
      titleOverridden: true,
      searchableText: "历史正文",
    });
    const group = await repo.createTaskGroup({ title: "自定义分组" });
    db = new DatabaseSync(path);
    db.prepare(`INSERT INTO task_group_members
      (group_id, workspace_key, workspace_path, workspace_identity, task_id, sort_order, added_at, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, 23, 1, 1, 2)`).run(
      group.id,
      source.workspacePath,
      source.workspacePath,
      meta.taskId,
    );
    db.prepare(`INSERT INTO task_group_view_node_orders
      (node_type, node_key, sort_order, created_at, updated_at) VALUES ('task', ?, 42, 1, 2)`).run(
      JSON.stringify([source.workspacePath, meta.taskId]),
    );
    assert.equal(await repo.reconcileWorktreeTaskScope({ taskId: meta.taskId, workspace }), true);
    assert.equal(await repo.reconcileWorktreeTaskScope({ taskId: meta.taskId, workspace }), false);
    assert.equal(await repo.getTaskMeta({ ...source, taskId: meta.taskId }), null);
    const migrated = await repo.getTaskMeta({ ...origin, taskId: meta.taskId });
    assert.equal(migrated?.title, meta.title);
    assert.equal(migrated?.unreadAt, 7);
    const row = db
      .prepare(
        "SELECT pinned, archived, title_overridden, searchable_text FROM tasks WHERE workspace_key = ?",
      )
      .get(origin.workspacePath);
    assert.deepEqual(
      { ...row },
      { pinned: 1, archived: 1, title_overridden: 1, searchable_text: "历史正文" },
    );
    const member = db
      .prepare(
        "SELECT workspace_key, workspace_path, group_id, sort_order FROM task_group_members WHERE task_id = ?",
      )
      .get(meta.taskId);
    assert.deepEqual(
      { ...member },
      {
        workspace_key: origin.workspacePath,
        workspace_path: origin.workspacePath,
        group_id: group.id,
        sort_order: 23,
      },
    );
    assert.equal(
      db
        .prepare("SELECT sort_order FROM task_group_view_node_orders WHERE node_key = ?")
        .get(JSON.stringify([origin.workspacePath, meta.taskId]))?.sort_order,
      42,
    );
  } finally {
    db?.close();
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("原项目已有状态优先，错放行不能覆盖，远端同路径不跨 Host 迁移", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lcode-worktree-scope-"));
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  try {
    await repo.syncTaskMeta({ meta, pinned: true });
    await repo.syncTaskMeta({
      meta: { ...meta, ...origin, title: "原项目标题" },
      titleOverridden: true,
    });
    assert.equal(await repo.reconcileWorktreeTaskScope({ taskId: meta.taskId, workspace }), true);
    assert.equal((await repo.getTaskMeta({ ...origin, taskId: meta.taskId }))?.title, "原项目标题");
    const hostA = { kind: "docker", container: "host-a" } as const;
    const hostB = { kind: "docker", container: "host-b" } as const;
    const identityA = buildRemoteWorkspaceIdentity(source.workspacePath, hostA);
    await repo.syncTaskMeta({ meta: { ...meta, workspaceIdentity: identityA } });
    assert.equal(
      await repo.reconcileWorktreeTaskScope({
        taskId: meta.taskId,
        workspace: {
          ...workspace,
          workspaceIdentity: buildRemoteWorkspaceIdentity(source.workspacePath, hostB),
          originWorkspaceIdentity: buildRemoteWorkspaceIdentity(origin.workspacePath, hostB),
        },
      }),
      false,
    );
    assert.ok(
      await repo.getTaskMeta({ ...source, workspaceIdentity: identityA, taskId: meta.taskId }),
    );
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("桌面索引广播与手机 replayable 快照都归属原项目，执行路径保持工作树", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lcode-worktree-projection-"));
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  const snapshot = lcodeSessionStateSnapshotSchema.parse({
    protocol: { name: LCODE_PROTOCOL_NAME, version: LCODE_PROTOCOL_VERSION },
    session: {
      sessionId: meta.taskId,
      workspace: { ...workspace, workspaceKey: source.workspacePath },
      sessionKind: "interactive",
      title: meta.title,
      mode: "build",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    },
    settings: {
      model: { available: [] },
      thoughtLevel: { enabled: false, available: [] },
      mode: { current: "build" },
    },
    projection: {
      sessionId: meta.taskId,
      status: "idle",
      mode: "build",
      turnCount: 0,
      totalTokenCount: 0,
      contextUsed: 0,
      contextWindow: 200000,
      pendingPermissions: [],
      activeToolCalls: [],
      backgroundJobs: [],
    },
    runtime: { eventSeq: 4, stateRevision: 3, pendingRequestIds: [] },
    messages: [],
    slashCommands: [],
  });
  const agentService = {
    async resumeSession() {
      return snapshot;
    },
    onAgentRuntimeLifecycle: () => ({ dispose() {} }),
    getWorkspaceRuntimeIdentity: () => null,
    disposeAll() {},
  } as unknown as ILCodeAgentService;
  const syncer = createLCodeTaskIndexSyncer({ agentService, taskIndexRepo: repo });
  const service = createLCodeTaskServiceAdapter({
    lcodeAgentService: agentService,
    taskIndexRepo: repo,
    taskIndexSyncer: syncer,
  });
  const events: LCodeWorkspaceEvent[] = [];
  const subscription = syncer.onDynamicWorkspaceEvent(origin)((event) => events.push(event));
  try {
    await repo.syncTaskMeta({ meta });
    const indexed = await syncer.syncSnapshotAndBroadcast(snapshot, {
      broadcastReason: "task_meta_changed",
    });
    assert.equal(indexed.workspacePath, origin.workspacePath);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.workspacePath, origin.workspacePath);
    assert.equal(await repo.getTaskMeta({ ...source, taskId: meta.taskId }), null);
    for (const clientMode of ["desktop-continuous", "web-remote-replayable"] as const) {
      await repo.syncTaskMeta({ meta });
      const before: number = events.length;
      const result = await service.getTaskSnapshot({ ...origin, taskId: meta.taskId, clientMode });
      assert.equal(result?.meta.workspacePath, origin.workspacePath);
      assert.equal(events.length, before + 1);
      assert.equal(await repo.getTaskMeta({ ...source, taskId: meta.taskId }), null);
    }
    assert.equal(snapshot.session.workspace.workspacePath, source.workspacePath);
  } finally {
    subscription.dispose();
    // Host 创建的实例持有本地清理入口，RPC 的 ILCodeTaskService 不暴露该生命周期方法。
    (service as typeof service & { disposeAll(): void }).disposeAll();
    await rm(dir, { recursive: true, force: true });
  }
});
