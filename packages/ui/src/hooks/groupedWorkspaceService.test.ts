import assert from "node:assert/strict";
import test from "node:test";
import { Event } from "@lcode/rpc";
import { buildRemoteWorkspaceIdentity } from "@lcode/shared";
import type { IServiceAccessor, LCodeGroupedTaskViewOrderInput } from "@lcode/services";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { createGroupedWorkspaceTaskService } from "./groupedWorkspaceService.js";

function fixture() {
  const writes: { owner: string; method: string; args: unknown }[] = [];
  const group = {
    id: "same-group",
    title: "same title",
    color: "gray",
    createdAt: 1,
    updatedAt: 1,
  };
  const owner = (key: string) =>
    ({
      lcodeTaskService: {
        listGroupedTaskViewStructure: async () => ({
          groups: [group],
          members: [],
          topLevelOrders: [{ type: "group", groupId: group.id, sortOrder: 1 }],
        }),
        renameTaskGroup: async (args: { groupId: string; title: string }) => {
          writes.push({ owner: key, method: "rename", args });
          return { ...group, title: args.title };
        },
        applyGroupedTaskViewOrder: async (args: unknown) => {
          writes.push({ owner: key, method: "order", args });
          return { nodes: [] };
        },
        listTasks: async (args: unknown) => {
          writes.push({ owner: key, method: "list", args });
          return [];
        },
        onDynamicWorkspaceEvent: () => Event.None,
      },
    }) as unknown as IServiceAccessor;
  const base = owner("local");
  const target = { kind: "ssh" as const, host: "example.invalid", username: "fixture" };
  const identity = buildRemoteWorkspaceIdentity("/same", target);
  const tabs = [
    { kind: "workspace", id: "local", label: "same", workspacePath: "/same" },
    {
      kind: "workspace",
      id: "remote",
      label: "same",
      workspacePath: "/same",
      workspaceIdentity: identity,
      remoteSessionId: "session",
      remoteTarget: target,
    },
  ] as WorkspaceTabState[];
  const state = {
    sessionsById: { session: { sessionId: "session", services: owner("ssh"), target } },
    sessionIdByWorkspaceIdentity: { [identity]: "session" },
    sessionIdByWorkspacePath: {},
  };
  return {
    writes,
    base,
    tabs,
    state,
    identity,
    service: createGroupedWorkspaceTaskService(base, tabs, state),
  };
}
test("同 ID 本地/SSH 分组隔离，读取和 rename 发给实际 owner", async () => {
  const f = fixture();
  const scopes = f.tabs.map((tab) => ({
    workspacePath: tab.workspacePath,
    workspaceIdentity: tab.workspaceIdentity,
  }));
  const view = await f.service.listGroupedTaskViewStructure({ workspaceScopes: scopes });
  assert.equal(view.groups.length, 2);
  assert.ok(view.groups[0]);
  assert.ok(view.groups[1]);
  assert.equal(view.groups[0].id, "same-group");
  assert.notEqual(view.groups[1].id, "same-group");
  const renamed = await f.service.renameTaskGroup({
    groupId: view.groups[1].id,
    title: "remote renamed",
  });
  assert.equal(renamed.id, view.groups[1].id);
  assert.deepEqual(
    f.writes.map((write) => write.owner),
    ["ssh"],
  );
  assert.ok(f.writes[0]);
  assert.equal((f.writes[0].args as { groupId: string }).groupId, "same-group");
  await f.service.listTasks(scopes[1]!);
  assert.equal(f.writes.at(-1)!.owner, "ssh");
});
test("跨 owner 移动在任何写入前拒绝；合法排序按各自事务分发", async () => {
  const f = fixture();
  const view = await f.service.listGroupedTaskViewStructure({ workspaceScopes: f.tabs });
  assert.ok(view.groups[1]);
  const input: LCodeGroupedTaskViewOrderInput = {
    workspaceScopes: f.tabs,
    topLevelNodes: view.groups.map((group) => ({ type: "group", groupId: group.id })),
    groups: [
      { groupId: view.groups[1].id, taskRefs: [{ workspacePath: "/same", taskId: "local-task" }] },
    ],
  };
  await assert.rejects(f.service.applyGroupedTaskViewOrder(input), /跨连接/);
  assert.equal(f.writes.length, 0);
  await f.service.applyGroupedTaskViewOrder({
    ...input,
    groups: [
      {
        groupId: view.groups[1].id,
        taskRefs: [
          { workspacePath: "/same", workspaceIdentity: f.identity, taskId: "remote-task" },
        ],
      },
    ],
  });
  assert.deepEqual(
    f.writes.map((write) => write.owner),
    ["local", "ssh"],
  );
  assert.equal(
    (f.writes[1]!.args as LCodeGroupedTaskViewOrderInput).groups[0]!.groupId,
    "same-group",
  );
});
test("远端未绑定不回退本机读取", async () => {
  const f = fixture();
  const service = createGroupedWorkspaceTaskService(f.base, f.tabs, {
    ...f.state,
    sessionsById: {},
  });
  await assert.rejects(service.listGroupedTaskViewStructure({ workspaceScopes: f.tabs }), /离线/);
  assert.equal(f.writes.length, 0);
});
