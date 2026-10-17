import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import {
  isSameLocalProjectPath,
  localProjectPathKey,
  projectDefinitionKey,
  projectDefinitionSchema,
  projectMutationRequestSchema,
  type AppSettings,
  type ProjectDefinition,
  type ProjectMutationRequest,
  type ProjectMutationResult,
} from "@lcode/shared";

function withMembers(project: ProjectDefinition, previous?: ProjectDefinition): ProjectDefinition {
  const members = project.sourceFolderPaths.map((path) => {
    const requested = project.members?.find((member) => isSameLocalProjectPath(member.path, path));
    const existing = previous?.members?.find((member) => isSameLocalProjectPath(member.path, path));
    return {
      id: existing?.id ?? randomUUID(),
      path,
      role: requested?.role ?? "",
      label: requested?.label ?? "",
      description: requested?.description ?? "",
      enabled: requested?.enabled ?? true,
    };
  });
  const requestedOrder = project.memberOrder ?? project.members?.map((member) => member.id) ?? [];
  const orderedPaths = requestedOrder.flatMap(
    (id) => project.members?.find((member) => member.id === id)?.path ?? [],
  );
  const order = [...members]
    .sort((a, b) => {
      const index = (path: string) => {
        const i = orderedPaths.findIndex((item) => isSameLocalProjectPath(item, path));
        return i < 0 ? orderedPaths.length : i;
      };
      return index(a.path) - index(b.path);
    })
    .map((member) => member.id);
  return projectDefinitionSchema.parse({ ...project, members, memberOrder: order });
}

/** 只由 SettingService 在既有文件锁、队列内调用；没有第二个设置文件写入者。 */
export async function applyProjectMutation(
  current: AppSettings,
  input: ProjectMutationRequest,
): Promise<{ next?: AppSettings; result: ProjectMutationResult }> {
  const request = projectMutationRequestSchema.parse(input);
  const signature = JSON.stringify(request);
  const receipt = current.projectMutationReceipts?.find(
    (item) => item.operationId === request.operationId,
  );
  if (receipt) {
    if (receipt.request !== signature)
      throw new Error("Project operationId reused with different content");
    return { result: receipt.result };
  }
  const projects =
    current.projectDefinitions?.projects ??
    current.localProjects.map((project) => withMembers(project));
  const index = projects.findIndex((project) => project.id === request.projectId);
  const previous = projects[index];
  const result = (status: ProjectMutationResult["status"], reason?: string) => ({
    status,
    project: previous ?? null,
    ...(reason ? { reason } : {}),
  });
  if (
    request.expectedRevision === null
      ? Boolean(previous)
      : !previous || (previous.revision ?? 0) !== request.expectedRevision
  )
    return {
      result: result(
        "conflict",
        previous ? "Project was changed in another window" : "Project no longer exists",
      ),
    };
  let saved: ProjectDefinition | null = null;
  if (request.type === "save") {
    const candidate = request.project;
    if (candidate.id !== request.projectId)
      return { result: result("validation_failed", "Project id does not match") };
    if (
      previous &&
      (projectDefinitionKey(previous) !== projectDefinitionKey(candidate) ||
        !isSameLocalProjectPath(previous.primaryFolderPath, candidate.primaryFolderPath))
    )
      return {
        result: result(
          "validation_failed",
          "The primary folder and source identity cannot be changed",
        ),
      };
    const duplicate = projects.find(
      (project) =>
        project.id !== request.projectId &&
        projectDefinitionKey(project) === projectDefinitionKey(candidate),
    );
    if (duplicate)
      return {
        result: {
          status: "conflict",
          project: duplicate,
          reason: "A project already exists for this source",
        },
      };
    // 中文依据：历史目录可能临时离线，只检查新增本地目录；远端目录必须由目标服务探测，不能在本机 stat。
    if (!candidate.workspaceIdentity) {
      const added = candidate.sourceFolderPaths.filter(
        (path) =>
          !previous?.sourceFolderPaths.some((existing) => isSameLocalProjectPath(existing, path)),
      );
      for (let offset = 0; offset < added.length; offset += 4) {
        const checks = await Promise.all(
          added.slice(offset, offset + 4).map(async (path) => {
            try {
              return (await stat(path)).isDirectory() ? null : `${path}: Not a directory`;
            } catch (error) {
              return `${path}: ${error instanceof Error ? error.message : String(error)}`;
            }
          }),
        );
        const failure = checks.find(Boolean);
        if (failure) return { result: result("validation_failed", failure) };
      }
    }
    saved = withMembers({ ...candidate, revision: (previous?.revision ?? 0) + 1 }, previous);
  }
  const nextProjects = [...projects];
  if (previous) nextProjects.splice(index, 1, ...(saved ? [saved] : []));
  else if (saved) nextProjects.unshift(saved);
  const applied: ProjectMutationResult = { status: "applied", project: saved };
  const next: AppSettings = {
    ...current,
    projectDefinitions: { version: 1, projects: nextProjects },
    localProjects: nextProjects
      .filter((project) => !project.workspaceIdentity)
      .map(({ workspaceIdentity: _identity, ...project }) => project),
    projectMutationReceipts: [
      ...(current.projectMutationReceipts ?? []),
      { operationId: request.operationId, request: signature, result: applied },
    ].slice(-256),
  };
  if (request.type === "remove" && previous && !previous.workspaceIdentity) {
    const retained = new Set(
      next.localProjects.flatMap((project) => project.sourceFolderPaths.map(localProjectPathKey)),
    );
    const removed = new Set(
      previous.sourceFolderPaths.map(localProjectPathKey).filter((key) => !retained.has(key)),
    );
    next.recentProjects = current.recentProjects.filter(
      (path) => !removed.has(localProjectPathKey(path)),
    );
    next.lastWorkspaceSession = (current.lastWorkspaceSession ?? []).filter(
      (entry) =>
        entry.kind === "remote" ||
        (entry.localProjectId !== previous.id &&
          !removed.has(localProjectPathKey(entry.workspacePath))),
    );
    next.lastActiveTabIndex = Math.min(
      current.lastActiveTabIndex ?? 0,
      Math.max(0, next.lastWorkspaceSession.length - 1),
    );
  }
  return { next, result: applied };
}
