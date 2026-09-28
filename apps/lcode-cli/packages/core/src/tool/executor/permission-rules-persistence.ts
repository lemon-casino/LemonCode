// project 级权限规则的读取与持久化（从 permission-flow.ts 拆出）。
// 拆分原因：permission-flow.ts 引入 responder 竞速后超过单文件 400 行上限；
// 这三个 helper 只与 sessionStore 的 project permission 存取内聚，与 ask 时序无关。
import {
  traceContextToLogContext,
  type PermissionRuleset,
  type PermissionUpdate,
  type ProjectId,
  type TraceContext,
} from "@lcode/contracts";
import { applyPermissionUpdates } from "./permission-rules.js";
import type { ToolExecutorDeps } from "./types.js";

export async function loadProjectPermissionRuleset(
  deps: ToolExecutorDeps,
): Promise<PermissionRuleset | null> {
  if (!deps.sessionStore) return null;
  const projectId = await resolveProjectId(deps);
  if (!projectId) return null;
  return deps.sessionStore.getProjectPermission(projectId);
}

export async function persistProjectPermissionUpdates(
  deps: ToolExecutorDeps,
  updates: PermissionUpdate[],
  traceContext: TraceContext,
): Promise<void> {
  if (updates.length === 0) return;

  if (!deps.sessionStore) {
    deps.logger?.warn("Project permission update skipped without session store", {
      ...traceContextToLogContext(traceContext),
      event: "tool.permission.project_update.skipped",
      module: "core.tool.executor",
      status: "completed",
    });
    return;
  }

  const projectID = await resolveProjectId(deps);
  if (!projectID) {
    deps.logger?.warn("Project permission update skipped without persisted session", {
      ...traceContextToLogContext(traceContext),
      event: "tool.permission.project_update.skipped",
      module: "core.tool.executor",
      status: "completed",
    });
    return;
  }

  const current = (await deps.sessionStore.getProjectPermission(projectID)) ?? { version: 1 };
  const next = applyPermissionUpdates(current, updates);
  await deps.sessionStore.saveProjectPermission({ projectID, permission: next });

  deps.logger?.info("Project permission updated", {
    ...traceContextToLogContext(traceContext),
    event: "tool.permission.project_update.saved",
    module: "core.tool.executor",
    status: "completed",
    updateCount: updates.length,
  });
}

async function resolveProjectId(deps: ToolExecutorDeps): Promise<ProjectId | undefined> {
  const session = await deps.sessionStore?.getSession(deps.sessionId);
  return session?.projectID;
}
