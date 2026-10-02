import {
  type LCodeSessionInfo,
  type LCodeSessionKind,
  type LCodeSessionSettingsState,
  type LCodeWorkspaceRef,
} from "@lcode/shared";

import { type SessionInfo, type SessionProjection } from "@lcode/contracts";

import type { LCodeApp } from "../app/types.js";

import { formatProtocolModelSelection, optionalModelSelectionFromString } from "./model-mapper.js";

import { positiveInteger } from "./session-mapper-values.js";

import { mapSessionGoal } from "./session-goal-timeline.js";

export async function mapSessionSettings(
  app: LCodeApp,
  options: {
    currentModelContextWindow?: number;
    modelAvailability?: "all" | "current";
  } = {},
): Promise<LCodeSessionSettingsState> {
  const thoughtLevels = app.listThoughtLevels();
  const rawCurrentThoughtLevel = app.getThoughtLevel();
  // setModel 后 runtime 可能短暂保留上一个模型的 thoughtLevel。
  // 协议 snapshot 是 UI/测试共同事实源，不能返回不在当前模型可选列表里的 current。
  const currentThoughtLevel =
    rawCurrentThoughtLevel && thoughtLevels.includes(rawCurrentThoughtLevel)
      ? rawCurrentThoughtLevel
      : undefined;
  const rawDefaultThoughtLevel = app.getDefaultThoughtLevel();
  const defaultThoughtLevel =
    rawDefaultThoughtLevel && thoughtLevels.includes(rawDefaultThoughtLevel)
      ? rawDefaultThoughtLevel
      : undefined;
  const currentModel = app.getModel();
  const currentModelOption = app.getCurrentModelOption?.();
  const availableModels =
    options.modelAvailability === "current"
      ? currentModelOption
        ? [
            {
              ...currentModelOption,
              contextWindow:
                positiveInteger(options.currentModelContextWindow) ??
                currentModelOption.contextWindow,
            },
          ]
        : app
            .listModels()
            .filter((candidate) => formatProtocolModelSelection(candidate.ref) === currentModel)
      : app.listModels();
  return {
    mode: {
      current: app.getMode(),
    },
    model: {
      // app/stdio 场景下 provider catalog 属于 app 状态，不应随每次 session/read、
      // setModel 回包返回完整模型市场；session settings 只需要表达当前运行模型即可。
      available: availableModels,
      // Session 原选择是后续输入解析的依据；字符串和过滤后的档位会丢失原意图。
      // current 允许暂时不可执行，展示/派发的有效性由公共 Selection View 决定。
      current: app.runtime.getSessionModelSelection(),
      lastUsed: optionalModelSelectionFromString(currentModel),
    },
    permission: {
      mode: app.getMode(),
    },
    thoughtLevel: {
      available: thoughtLevels.map((level) => ({ label: level, value: level })),
      current: currentThoughtLevel,
      // 云端 reasoning.defaultLevel 只存在于模型事实中，旧 settings
      // 没有携带默认档位，UI 在 current 为空时只能误选 available[0]。
      ...(defaultThoughtLevel ? { defaultLevel: defaultThoughtLevel } : {}),
      enabled: thoughtLevels.length > 0,
    },
  };
}

export function mapSessionInfo(input: {
  app?: Pick<LCodeApp, "getMode" | "getModel" | "sessionId" | "traceId">;
  fallbackCreatedAt?: number;
  fallbackUpdatedAt?: number;
  projection?: SessionProjection;
  session?: SessionInfo | null;
  taskType?: SessionInfo["taskType"];
  parentSessionId?: string;
  workspace: LCodeWorkspaceRef;
}): LCodeSessionInfo {
  const sessionId = String(input.session?.id ?? input.app?.sessionId ?? "unknown");
  // 刚创建的 protocol session 可能还没有持久化 session 行。
  // 此时 runtime projection 的时间可能继承 workspace 预热 draft，不能作为正式 session 时间。
  const createdAt =
    input.session?.time.created ??
    input.fallbackCreatedAt ??
    input.projection?.createdAt.getTime() ??
    Date.now();
  const updatedAt =
    input.session?.time.updated ??
    input.fallbackUpdatedAt ??
    input.projection?.updatedAt.getTime() ??
    createdAt;
  return {
    archivedAt: input.session?.time.archived,
    createdAt,
    mode: input.projection?.mode ?? input.app?.getMode?.() ?? "build",
    model: input.app ? optionalModelSelectionFromString(input.app.getModel()) : undefined,
    parentSessionId: input.session?.parentID ?? input.parentSessionId,
    traceId: input.session?.traceID ?? input.app?.traceId,
    sessionId,
    sessionKind: (input.session?.taskType ?? input.taskType ?? "interactive") as LCodeSessionKind,
    status: input.projection?.status ?? "idle",
    target: mapSessionGoal(input.projection?.target),
    title: input.session?.title ?? "",
    titleSource: input.session?.titleSource,
    updatedAt,
    workspace: input.workspace,
  };
}
