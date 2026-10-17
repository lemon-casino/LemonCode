import {
  executionSetSnapshotSchema,
  projectContextForDefinition,
  replaceRemoteWorkspaceIdentityPath,
  type ExecutionSetSnapshot,
} from "@lcode/shared";
import type { IServiceAccessor, WorktreeBinding } from "@lcode/services";
import type { LCodeTaskMeta } from "@lcode/shared";

export function sidebarExecutionSetFixture(
  origin: string,
  identity: string | undefined,
  calls: Array<{ method: string; params: unknown }>,
) {
  const id = identity ? "b".repeat(32) : "a".repeat(32);
  const sourcePaths = [origin, identity ? "/fixture/remote-api" : "/fixture/backend"];
  const scope = { workspacePath: origin, ...(identity ? { workspaceIdentity: identity } : {}) };
  const context = projectContextForDefinition(
    {
      id: identity ? "remote-project" : "project",
      name: identity ? "远程协作" : "前后端协作",
      primaryFolderPath: origin,
      sourceFolderPaths: sourcePaths,
      ...(identity ? { workspaceIdentity: identity } : {}),
    },
    scope,
  );
  let snapshot = executionSetSnapshotSchema.parse({
    version: 1,
    id,
    name: identity ? "远程登录联调" : "前后端登录联调",
    preparationName: "Login",
    revision: 1,
    requestId: `prepare-${id}`,
    fingerprint: id,
    origin: scope,
    projectContext: context,
    status: "ready",
    repositories: sourcePaths.map((path, index) => ({
      id: `${index + (identity ? 3 : 1)}`.repeat(32),
      repositoryRoot: path,
      commonDirectory: `${path}/.git`,
      baseRef: "HEAD",
      memberIds: [context.members[index]!.memberId],
      status: "ready",
      bindingId: `${index + (identity ? 7 : 5)}`.repeat(32),
    })),
    sessions: [{ sessionId: `chat-${id}`, operationId: "chat", status: "attached" }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const listeners = new Set<(snapshot: ExecutionSetSnapshot) => void>();
  const publish = (patch: Partial<ExecutionSetSnapshot>) => {
    snapshot = executionSetSnapshotSchema.parse({
      ...snapshot,
      ...patch,
      revision: snapshot.revision + 1,
    });
    listeners.forEach((listener) => listener(structuredClone(snapshot)));
    return structuredClone(snapshot);
  };
  const bindings = () =>
    snapshot.repositories.map((repository): WorktreeBinding => {
      const checkoutPath = `/fixture/sets/${id}/${repository.id}`;
      const workspaceIdentity = identity
        ? (replaceRemoteWorkspaceIdentityPath(identity, checkoutPath) ?? undefined)
        : undefined;
      return {
        id: repository.bindingId!,
        requestId: snapshot.requestId,
        ownerRef: { kind: "executionSet", executionSetId: id, repositoryId: repository.id },
        originalWorkspacePath: repository.repositoryRoot,
        originalWorkspaceIdentity: identity
          ? (replaceRemoteWorkspaceIdentityPath(identity, repository.repositoryRoot) ?? undefined)
          : undefined,
        repositoryRoot: repository.repositoryRoot,
        commonDirectory: repository.commonDirectory,
        checkoutPath,
        checkoutRoot: "/fixture/sets",
        workspacePath: checkoutPath,
        workspaceIdentity,
        branch: `lcode/${repository.id.slice(0, 6)}`,
        baseCommit: "head",
        targetBranch: "main",
        sourceFolderPaths: [checkoutPath],
        status: snapshot.status === "archived" ? "archived" : "ready",
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
      };
    });
  const check = (request: { workspacePath: string; workspaceIdentity?: string }) => {
    if ((request.workspaceIdentity || request.workspacePath) !== (identity || origin))
      throw new Error("Fixture execution set scope mismatch");
  };
  const service: NonNullable<IServiceAccessor["projectExecutionSetService"]> = {
    capabilities: async () => ({ protocolVersion: 1, multiRepository: true }),
    list: async (request) => {
      check(request);
      return [structuredClone(snapshot)];
    },
    get: async (request) => {
      check(request);
      return request.executionSetId === id ? structuredClone(snapshot) : null;
    },
    bindings: async (request) => {
      check(request);
      calls.push({ method: identity ? "remoteSetBindings" : "localSetBindings", params: request });
      return snapshot.repositories.map((repository, index) => ({
        repositoryId: repository.id,
        binding: bindings()[index]!,
        integration: {
          operationId: `review-${repository.id}`,
          bindingId: repository.bindingId!,
          status: index ? ("validation-failed" as const) : ("published" as const),
          sourceHead: "source",
          targetHead: "target",
          targetBranch: "main",
          updatedAt: snapshot.updatedAt,
          ...(index ? { error: "Fixture validation failed" } : {}),
        },
        error: repository.error,
      }));
    },
    retry: async (request) => {
      check(request);
      calls.push({ method: "retrySet", params: request });
      if (request.operationId !== snapshot.requestId)
        throw new Error("Retry must retain preparation key");
      return publish({
        status: "ready",
        error: undefined,
        repositories: snapshot.repositories.map((repository) => ({
          ...repository,
          status: "ready",
          error: undefined,
        })),
      });
    },
    rename: async (request) => {
      check(request);
      calls.push({ method: "renameSet", params: request });
      if (request.expectedRevision !== snapshot.revision) throw new Error("Concurrent edit");
      return publish({ name: request.name });
    },
    archive: async (request) => {
      check(request);
      calls.push({ method: "archiveSet", params: request });
      return publish({
        status: "archived",
        sessions: snapshot.sessions.map((session) => ({ ...session, status: "released" })),
      });
    },
    restore: async (request) => {
      check(request);
      calls.push({ method: "restoreSet", params: request });
      return publish({ status: "ready" });
    },
    onDidChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  return {
    service,
    bindings,
    snapshot: () => snapshot,
    fail: () =>
      publish({
        status: "failed",
        error: "Backend permission denied",
        repositories: snapshot.repositories.map((repository, index) =>
          index
            ? {
                ...repository,
                status: "failed",
                error: `${repository.repositoryRoot}: EACCES reading Git directory`,
              }
            : repository,
        ),
      }),
  };
}

export function installSidebarExecutionSets(
  services: IServiceAccessor,
  remoteServices: IServiceAccessor,
  tasks: LCodeTaskMeta[],
  origin: string,
  identity: string,
  calls: Array<{ method: string; params: unknown }>,
  enabled: boolean,
) {
  const localSet = sidebarExecutionSetFixture(origin, undefined, calls);
  const remoteSet = sidebarExecutionSetFixture(origin, identity, calls);
  if (!enabled) return { localSet, remoteSet, tasks };
  services.projectExecutionSetService = localSet.service;
  remoteServices.projectExecutionSetService = remoteSet.service;
  for (const [service, fixture] of [
    [services, localSet],
    [remoteServices, remoteSet],
  ] as const) {
    const getBinding = service.worktreeService!.getBinding;
    service.worktreeService!.getBinding = async (request) =>
      request.bindingId
        ? (fixture.bindings().find((binding) => binding.id === request.bindingId) ?? null)
        : getBinding(request);
  }
  const reference = (fixture: typeof localSet) => ({
    executionSetId: fixture.snapshot().id,
    projectId: fixture.snapshot().projectContext.projectId,
    origin: fixture.snapshot().origin,
    bindings: fixture
      .bindings()
      .map((binding, index) => ({
        repositoryId: fixture.snapshot().repositories[index]!.id,
        bindingId: binding.id,
        workspacePath: binding.workspacePath,
        ...(binding.workspaceIdentity ? { workspaceIdentity: binding.workspaceIdentity } : {}),
      })),
  });
  const nextTasks = [
    ...tasks,
    ...[localSet, remoteSet].map((fixture) => ({
      ...tasks[0]!,
      ...fixture.snapshot().origin,
      taskId: fixture.snapshot().sessions[0]!.sessionId,
      title: fixture === localSet ? "协作工作集会话" : "远程协作会话",
      executionSetRef: reference(fixture),
    })),
  ];
  const rowsRange = services.lcodeAgentService.conversationRowsRangeV4;
  services.lcodeAgentService.conversationRowsRangeV4 = async (request) => {
    const fixture = [localSet, remoteSet].find((fixture) =>
      fixture.snapshot().sessions.some((session) => session.sessionId === request.sessionId),
    );
    if (!fixture) return rowsRange(request);
    const projectContext = structuredClone(fixture.snapshot().projectContext);
    projectContext.executionSetId = fixture.snapshot().id;
    projectContext.members.forEach((member, index) => {
      member.workspacePath = fixture.bindings()[index]!.workspacePath;
    });
    projectContext.execution = { workspacePath: projectContext.members[0]!.workspacePath };
    return {
      rows: [
        {
          rowId: 1,
          turnId: "turn",
          kind: "userInput",
          origin: "realUser",
          text: "Implement login",
          createdAt: 1,
          createdAtSeq: 1,
          projectContext,
        },
      ],
      hasMore: false,
      atRevision: 7,
      atSeq: 1,
      atLogEpoch: "fixture",
    };
  };
  return { localSet, remoteSet, tasks: nextTasks };
}
