import type { IServiceAccessor, WorktreeBinding } from "@lcode/services";
import {
  V4_WIRE_PROTOCOL_VERSION,
  type CommandAck,
  type CommandEnvelope,
} from "@lcode/shared/lcode-protocol-v4";
import { useDraftExecutionStore } from "@/store/draftExecutionStore.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
const emptyEvent = () => ({ dispose() {} });

export function beginFixtureDraftExecution(scope: string) {
  const envelope = {
    ...createCommandEnvelope({
      type: "createSession",
      sessionId: null,
      payload: {
        workspaceId: scope,
        execution: { mode: "worktree", baseRef: "feature" },
        firstInput: { text: "fixture first input" },
      },
    }),
    commandId: "same-request",
  };
  useDraftExecutionStore
    .getState()
    .begin(scope, envelope.commandId, true, { mode: "worktree", baseRef: "feature" }, envelope);
}

export function installForkPreparationFixture(
  services: IServiceAccessor,
  calls: { method: string; params: unknown }[],
  base: WorktreeBinding,
) {
  const control = {
    preparation: null as WorktreeBinding | null,
    holdCancel: true,
    failFork: false,
    loseForkAck: false,
    holdFork: false,
    releaseFork: () => {},
    beginPreparation: () => {
      const envelope = createCommandEnvelope({
        type: "createSession",
        sessionId: null,
        payload: {
          workspaceId: base.originalWorkspacePath,
          execution: { mode: "worktree" },
          firstInput: { text: "preserved input" },
        },
      });
      control.preparation = {
        ...base,
        taskId: "draft-task",
        requestId: envelope.commandId,
        status: "preparing",
        preparation: {
          stage: "checkout",
          activeStep: "checkout",
          log: "Preparing workspace\nChecking out files\n",
          logTruncated: false,
          cancelRequested: false,
          environmentSource: "none",
        },
      };
      useDraftExecutionStore
        .getState()
        .begin(base.originalWorkspacePath, "ui-request", true, { mode: "worktree" }, envelope);
    },
    /**
     * P2-07a 五阶段投影：托管环境进入工具/依赖阶段时，准备卡展开五步并显示来源标注。
     * toolSource 可切换（project-declaration / app-default / partial-host）。
     */
    beginManagedPreparation: (toolSource: string = "project-declaration") => {
      const envelope = createCommandEnvelope({
        type: "createSession",
        sessionId: null,
        payload: {
          workspaceId: base.originalWorkspacePath,
          execution: { mode: "worktree" },
          firstInput: { text: "preserved input" },
        },
      });
      control.preparation = {
        ...base,
        taskId: "draft-task",
        requestId: envelope.commandId,
        status: "preparing",
        environmentRef: { environmentId: "a".repeat(32), revision: 1 },
        preparation: {
          stage: "environment",
          activeStep: "environment",
          runtimeStage: "installingTools",
          toolSource: toolSource as "project-declaration",
          log: "Preparing workspace\nChecking out files\nInstalling managed tools\n",
          logTruncated: false,
          cancelRequested: false,
          environmentSource: "detected",
        },
      };
      useDraftExecutionStore
        .getState()
        .begin(base.originalWorkspacePath, "ui-request", true, { mode: "worktree" }, envelope);
    },
    /** P2-07a：推进到依赖阶段（工具步完成后）。 */
    advanceToDependencies: () => {
      if (!control.preparation?.preparation) return;
      control.preparation.preparation.runtimeStage = "preparingDependencies";
    },
    finishCancel: () => {
      control.preparation!.status = "cancelled";
      control.preparation!.preparation!.stage = "cancelled";
    },
    failPreparation: () => {
      control.preparation!.status = "failed";
      control.preparation!.preparation!.stage = "failed";
      control.preparation!.error = "fixture-environment-failed";
      useDraftExecutionStore
        .getState()
        .settle(base.originalWorkspacePath, "ui-request", "fixture-environment-failed");
    },
  };
  Object.assign(window, { __forkPreparationFixture: control });
  services.lcodeTaskService = {
    getTaskSessionFilePath: async () => ({ path: null, exists: false }),
    getTaskNativeSessionLogFile: async () => ({ path: null, exists: false, provider: null }),
  } as unknown as IServiceAccessor["lcodeTaskService"];
  const getBinding = services.worktreeService.getBinding;
  services.worktreeService.getBinding = async (params) =>
    params.requestId ? structuredClone(control.preparation) : getBinding(params);
  services.worktreeService.prepare = async (params) => {
    calls.push({ method: "prepare", params });
    if (
      !params.cancel ||
      !control.preparation ||
      params.requestId !== control.preparation.requestId
    )
      throw new Error("Unexpected preparation mutation");
    control.preparation.preparation!.cancelRequested = true;
    if (!control.holdCancel) control.finishCancel();
    return structuredClone(control.preparation);
  };
  const facts = new Map<string, CommandAck>();
  services.lcodeAgentService = {
    helloConversationV4: async () => ({
      kind: "hello",
      protocolVersion: V4_WIRE_PROTOCOL_VERSION,
      connectionId: "fixture",
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
    onDynamicConversationFrame: () => emptyEvent,
    onDynamicLocalTtftFacts: () => emptyEvent,
    onAgentRuntimeRestarted: emptyEvent,
    conversationRowsRangeV4: async (params: unknown) => {
      calls.push({ method: "forkRows", params });
      return { rows: [], hasMore: false, atRevision: 7, atSeq: 1, atLogEpoch: "fixture" };
    },
    sendConversationCommandV4: async (params: { envelope: CommandEnvelope }) => {
      calls.push({ method: "forkCommand", params });
      if (control.holdFork)
        await new Promise<void>((resolve) => {
          control.releaseFork = resolve;
        });
      const envelope = params.envelope;
      if (control.failFork)
        return {
          commandId: envelope.commandId,
          status: "failed",
          revisionAtDecision: 7,
          message: "fixture-parent-busy",
        };
      const mode = (envelope.payload as { workspaceMode: string }).workspaceMode;
      const ack: CommandAck = {
        commandId: envelope.commandId,
        status: "accepted",
        revisionAtDecision: 7,
        result: {
          type: "forkSession",
          sessionId: "child-" + mode,
          workspacePath: mode === "same" ? base.originalWorkspacePath : "/fixture/fork/tree",
        },
      };
      facts.set(envelope.commandId, ack);
      if (control.loseForkAck) {
        control.loseForkAck = false;
        throw new Error("fixture-ack-lost");
      }
      return ack;
    },
    queryConversationCommandsV4: async (params: {
      commands: { sessionId: string | null; commandId: string }[];
    }) => {
      calls.push({ method: "forkQuery", params });
      return {
        results: params.commands.map((key) => ({
          key,
          result: facts.get(key.commandId) ?? "unknown",
        })),
      };
    },
  } as unknown as IServiceAccessor["lcodeAgentService"];
}
