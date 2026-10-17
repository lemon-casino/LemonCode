import {
  projectMutationRequestSchema,
  projectDefinitionKey,
  type AppSettings,
  type ProjectDefinition,
  type ProjectMutationRequest,
  type ProjectMutationResult,
} from "@lcode/shared";

/** 浏览器交互桩；磁盘锁、CAS 和持久化本身由真实 SettingService 集成测试覆盖。 */
export function createSidebarProjectCommands(
  settings: Partial<AppSettings>,
  calls: Array<{ method: string; params: unknown }>,
) {
  return async (input: ProjectMutationRequest): Promise<ProjectMutationResult> => {
    const request = projectMutationRequestSchema.parse(input);
    calls.push({ method: "project", params: request });
    const projects = settings.projectDefinitions?.projects ?? settings.localProjects ?? [];
    const existing = projects.find((project) => project.id === request.projectId);
    const receipt = settings.projectMutationReceipts?.find(
      (item) => item.operationId === request.operationId,
    );
    if (receipt) return receipt.result;
    if (
      request.expectedRevision === null
        ? existing
        : !existing || (existing.revision ?? 0) !== request.expectedRevision
    )
      return { status: "conflict", project: existing ?? null, reason: "Concurrent project edit" };
    const duplicate =
      request.type === "save" &&
      projects.find(
        (project) =>
          project.id !== request.projectId &&
          projectDefinitionKey(project) === projectDefinitionKey(request.project),
      );
    if (duplicate)
      return { status: "conflict", project: duplicate, reason: "Duplicate project source" };
    let project: ProjectDefinition | null = null;
    if (request.type === "save") {
      const members =
        request.project.members ??
        request.project.sourceFolderPaths.map((path) => ({
          id: crypto.randomUUID(),
          path,
          role: "custom" as const,
          label: "",
          description: "",
          enabled: true,
        }));
      project = {
        ...request.project,
        revision: (existing?.revision ?? 0) + 1,
        members,
        memberOrder: request.project.memberOrder ?? members.map((member) => member.id),
      };
    }
    const next = projects.filter((item) => item.id !== request.projectId);
    if (project) next.unshift(project);
    settings.projectDefinitions = { version: 1, projects: next };
    settings.localProjects = next.filter((item) => !item.workspaceIdentity);
    const result = { status: "applied" as const, project };
    settings.projectMutationReceipts = [
      ...(settings.projectMutationReceipts ?? []),
      { operationId: request.operationId, request: JSON.stringify(request), result },
    ];
    localStorage.setItem("sidebar-fixture-projects", JSON.stringify(settings));
    return result;
  };
}

export function createHeldSidebarProjectCommands(
  settings: Partial<AppSettings>,
  calls: Array<{ method: string; params: unknown }>,
) {
  return withHeldProjectAcknowledgement(createSidebarProjectCommands(settings, calls));
}

export function withHeldProjectAcknowledgement(
  command: ReturnType<typeof createSidebarProjectCommands>,
) {
  let hold = false;
  let release: (() => void) | undefined;
  return {
    hold: () => {
      hold = true;
    },
    release: () => release?.(),
    pending: () => Boolean(release),
    mutateProject: async (request: ProjectMutationRequest) => {
      const result = await command(request);
      if (hold) {
        hold = false;
        await new Promise<void>((resolve) => {
          release = () => {
            release = undefined;
            resolve();
          };
        });
      }
      return result;
    },
  };
}
