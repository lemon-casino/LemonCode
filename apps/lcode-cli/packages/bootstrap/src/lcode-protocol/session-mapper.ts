import {
  LCODE_PROTOCOL_NAME,
  LCODE_PROTOCOL_VERSION,
  type LCodeDeliveryKind,
  type LCodeSessionStateSnapshot,
  type LCodeWorkspaceRef,
} from "@lcode/shared";

import {
  type MessageWithParts,
  type SessionEvent,
  type SessionGoal,
  type SessionInfo,
  type SessionProjection,
  type TodoItem,
} from "@lcode/contracts";

import type { LCodeApp } from "../app/types.js";

import {
  listProtocolSlashCommands,
  type ListProtocolSlashCommandsOptions,
} from "./slash-commands.js";

import {
  mergePersistedGoalVerificationEvents,
  withGoalSummaryTitleFallback,
} from "./session-goal-timeline.js";

import { mapSnapshotMessages } from "./session-snapshot-messages.js";

import { mapSessionProjection, mapRuntimeState } from "./session-projection-mapper.js";

import { mapSessionInfo, mapSessionSettings } from "./session-settings-mapper.js";

import { buildGoalStats } from "./session-goal-statistics.js";

import { mapTodoItem, buildTodoGroups } from "./session-todo-groups.js";

export async function buildSessionSnapshot(input: {
  app: LCodeApp;
  deliveryKind?: LCodeDeliveryKind;
  eventSeq: number;
  fallbackCreatedAt?: number;
  fallbackUpdatedAt?: number;
  lastError?: SessionProjection["lastError"];
  messages: MessageWithParts[];
  modelAvailability?: "all" | "current";
  persistedGoalVerificationEvents?: SessionEvent[];
  persistedContextUsageBreakdownEvents?: SessionEvent[];
  session?: SessionInfo | null;
  stateRevision: number;
  slashCommandOptions?: ListProtocolSlashCommandsOptions;
  target?: SessionGoal | null;
  todos?: TodoItem[];
  workspace: LCodeWorkspaceRef;
}): Promise<LCodeSessionStateSnapshot> {
  const runtimeProjection = await input.app.runtime.getProjection();
  const activeTurn = input.app.runtime.getActiveTurnInfo();
  const persistedGoalProjection = mergePersistedGoalVerificationEvents(
    runtimeProjection,
    input.persistedGoalVerificationEvents ?? [],
    input.target === undefined ? runtimeProjection.target : input.target,
  );
  // runtime projection 是运行期 eventStore reducer，恢复历史 session 时可能没有
  // target_changed 账本；session_target 表才是 goal 权威状态，snapshot 必须以 DB 读取值为准。
  const projectionWithoutTitleFallback =
    input.target === undefined && input.lastError === undefined
      ? persistedGoalProjection
      : {
          ...persistedGoalProjection,
          ...(input.target === undefined ? {} : { target: input.target }),
          ...(input.lastError === undefined ? {} : { lastError: input.lastError }),
        };
  const projection = withGoalSummaryTitleFallback(
    projectionWithoutTitleFallback,
    input.session,
    input.messages,
  );
  const messages = await mapSnapshotMessages(input.app, input.messages);
  return {
    messages,
    projection: mapSessionProjection(projection),
    protocol: {
      name: LCODE_PROTOCOL_NAME,
      version: LCODE_PROTOCOL_VERSION,
    },
    runtime: mapRuntimeState({
      activeTurn,
      deliveryKind: input.deliveryKind,
      eventSeq: input.eventSeq,
      messages: input.messages,
      persistedContextUsageBreakdownEvents: input.persistedContextUsageBreakdownEvents,
      projection,
      stateRevision: input.stateRevision,
    }),
    session: mapSessionInfo({
      app: input.app,
      fallbackCreatedAt: input.fallbackCreatedAt,
      fallbackUpdatedAt: input.fallbackUpdatedAt,
      projection,
      session: input.session,
      workspace: input.workspace,
    }),
    settings: await mapSessionSettings(input.app, {
      currentModelContextWindow: projection.contextWindow,
      modelAvailability: input.modelAvailability,
    }),
    slashCommands: await listProtocolSlashCommands({
      ...input.slashCommandOptions,
      workingDirectory: input.workspace.workspacePath,
    }),
    goalStats: buildGoalStats(projection, input.messages),
    todos: input.todos?.map(mapTodoItem) ?? [],
    todoGroups: buildTodoGroups(input.messages, input.todos ?? [], projection),
  };
}

export { mapSessionSettings, mapSessionInfo } from "./session-settings-mapper.js";

export {
  mapSessionEvent,
  mapSessionEventForProtocol,
  mapSessionEvents,
  shouldExposeSessionEventToProtocol,
} from "./session-event-mapper.js";

export { resolveSessionContextUsage } from "./session-context-usage.js";
