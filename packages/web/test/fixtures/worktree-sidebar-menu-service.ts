import { services as runtimeServices } from "./git-session-refresh-runtime.js";
import type { IServiceAccessor } from "@lcode/services";
import type { LCodeTaskMeta } from "@lcode/shared";
import { V4_WIRE_PROTOCOL_VERSION, type CommandEnvelope } from "@lcode/shared/lcode-protocol-v4";

export function installSidebarMenuServices(
  services: IServiceAccessor,
  calls: { method: string; params: unknown }[],
  getTasks: () => LCodeTaskMeta[],
  setTasks: (tasks: LCodeTaskMeta[]) => void,
) {
  const control = { sessionFileExists: true, failExecutionRead: false };
  const event = () => ({ dispose() {} });
  const update = (method: string, params: { taskId: string }, patch: Partial<LCodeTaskMeta>) => {
    calls.push({ method, params });
    const next = { ...getTasks().find((task) => task.taskId === params.taskId)!, ...patch };
    setTasks(getTasks().map((task) => (task.taskId === next.taskId ? next : task)));
    return structuredClone(next);
  };
  Object.assign(services.lcodeTaskService, {
    getTaskSessionFilePath: async ({ taskId }: { taskId: string }) => ({
      path: `/sessions/${taskId}.json`,
      exists: control.sessionFileExists,
    }),
    getTaskNativeSessionLogFile: async ({ taskId }: { taskId: string }) => ({
      path: `/logs/${taskId}.log`,
      exists: false,
      provider: "lcode",
    }),
    setTaskPinned: async (params: { taskId: string; pinned: boolean }) =>
      update("pin-task", params, { pinnedAt: params.pinned ? Date.now() : undefined }),
    renameTask: async (params: { taskId: string; title: string }) =>
      update("rename-task", params, { title: params.title }),
    setTaskUnread: async (params: { taskId: string }) =>
      update("unread-task", params, { unreadAt: Date.now() }),
    archiveTask: async (params: { taskId: string }) =>
      update("archive-task", params, { archivedAt: Date.now() }),
  });
  services.lcodeSessionService = {
    readSession: async ({ sessionId }: { sessionId: string }) => {
      if (control.failExecutionRead) throw new Error("fixture-session-unavailable");
      const task = getTasks().find((task) => task.taskId === sessionId)!;
      const binding = task.executionBindingId
        ? await services.worktreeService.getBinding({
            workspacePath: task.workspacePath,
            taskId: sessionId,
          })
        : null;
      return {
        session: {
          workspace: {
            workspacePath: binding?.workspacePath ?? task.workspacePath,
            executionBindingId: task.executionBindingId,
          },
        },
      };
    },
  } as unknown as IServiceAccessor["lcodeSessionService"];
  services.lcodeAgentService = {
    ...runtimeServices.lcodeAgentService,
    helloConversationV4: async () => ({
      kind: "hello",
      protocolVersion: V4_WIRE_PROTOCOL_VERSION,
      connectionId: "sidebar-fixture",
      clientMode: "web-remote-replayable",
      deliveryProfile: "replayable",
      serverTime: 1,
      capabilities: {
        nativeDialogs: false,
        localTerminal: false,
        binaryFrames: false,
        compression: "none",
      },
      auth: {},
    }),
    initializeConversationV4: async () => ({}),
    onDynamicLocalTtftFacts: () => event,
    onAgentRuntimeRestarted: event,
    conversationRowsRangeV4: async (params: unknown) => {
      calls.push({ method: "fork-rows", params });
      return { rows: [], hasMore: false, atRevision: 7, atSeq: 1, atLogEpoch: "fixture" };
    },
    sendConversationCommandV4: async (params: { envelope: CommandEnvelope }) => {
      calls.push({ method: "fork-command", params });
      return {
        commandId: params.envelope.commandId,
        status: "accepted",
        revisionAtDecision: 7,
        result: {
          type: "forkSession",
          sessionId: `child-${params.envelope.sessionId}-${(params.envelope.payload as { workspaceMode: string }).workspaceMode}`,
          workspacePath: "/fixture/repo",
        },
      };
    },
  } as unknown as IServiceAccessor["lcodeAgentService"];
  return control;
}
