/* oxlint-disable max-lines -- LCode session 到当前聊天 projection 的迁移桥需要同时保持 snapshot 和 event 映射一致。 */
import {
  decodeCustomModelValue,
  deriveLCodeTaskStatusFromSessionSnapshot,
  generateTraceId,
  parseModelPickerValue as parseSharedModelSelection,
  formatModelPickerValue as formatSharedModelSelection,
  resolveLCodeVisibleSessionTitle,
  LCODE_AGENT_PROVIDER,
  type LCodeConfigOption,
  type LCodeTaskGoal,
  type LCodeTaskMode,
  type LCodeTaskModeInfo,
  type LCodeTaskMeta,
  type LCodeMessageWithParts,
  type ModelSelection,
  type LCodeSessionMode,
  type LCodeSessionSettingsState,
  type LCodeSessionStateSnapshot,
} from "@lcode/shared";

const MODEL_CONFIG_ID = "model";
const THOUGHT_LEVEL_CONFIG_ID = "thought_level";
const MODE_CONFIG_ID = "mode";
const LCODE_AGENT_MODE_OPTIONS = [
  {
    id: "build",
    name: "Ask before changes",
    description: "Ask before each file changes.",
  },
  {
    id: "edit",
    name: "Edit automatically",
    description: "Edit selected files or relevant workspace files automatically.",
  },
  {
    id: "plan",
    name: "Plan mode",
    description: "Inspect the code and present a plan before editing.",
  },
  {
    id: "yolo",
    name: "Full access",
    description: "Edit and run commands with fewer confirmations.",
  },
] as const satisfies readonly LCodeTaskModeInfo[];
const LCODE_AGENT_MODE_ID_SET = new Set<string>(LCODE_AGENT_MODE_OPTIONS.map((mode) => mode.id));

export function formatModelPickerValue(ref: ModelSelection | undefined): string {
  return formatSharedModelSelection(ref);
}

function resolveLatestMessageModelSelection(
  messages: readonly LCodeMessageWithParts[],
): ModelSelection | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const model = messages[index]?.info.model;
    if (model) {
      return model;
    }
  }
  return undefined;
}

function resolveTaskMetaModelSelectionFromSnapshot(
  snapshot: LCodeSessionStateSnapshot,
): ModelSelection | undefined {
  // 历史 resume 被错误 runtimeModel 覆盖时，settings.current 会变成 app 当前默认模型，
  // 但消息 info.model 仍记录真实使用的模型。task meta 会作为下次冷恢复 hint，
  // 因此优先用最近消息模型让已污染的历史记录自愈。
  return resolveLatestMessageModelSelection(snapshot.messages) ?? snapshot.settings.model.current;
}

export function parseModelPickerValue(value: string): ModelSelection {
  const customModel = decodeCustomModelValue(value);
  if (customModel?.providerId && customModel.modelName) {
    // UI 自定义模型值是展示态 custom:provider:model，
    // LCode Protocol 必须收到严格的 providerId/modelId 结构。
    return {
      providerId: customModel.providerId,
      modelId: customModel.modelName,
    };
  }

  return parseSharedModelSelection(value);
}

export function lcodeSessionSettingsToConfigOptions(
  settings: LCodeSessionSettingsState,
): LCodeConfigOption[] {
  const configOptions: LCodeConfigOption[] = [
    {
      id: MODEL_CONFIG_ID,
      name: "Model",
      category: "model",
      type: "select",
      currentValue: formatModelPickerValue(settings.model.current),
      options: settings.model.available.map((model) => {
        const modelThoughtLevels = model.reasoning?.levels.map((level) => level.value);
        const modelDefaultThoughtLevel =
          model.reasoning?.defaultLevel &&
          modelThoughtLevels?.includes(model.reasoning.defaultLevel)
            ? model.reasoning.defaultLevel
            : undefined;
        return {
          value: formatModelPickerValue(model.ref),
          name: model.label,
          description: model.description,
          modelProviderId: model.ref.providerId,
          modelProviderName: model.providerLabel ?? model.ref.providerId,
          ...(modelThoughtLevels ? { modelThoughtLevels } : {}),
          ...(modelDefaultThoughtLevel ? { modelDefaultThoughtLevel } : {}),
        };
      }),
    },
    {
      id: MODE_CONFIG_ID,
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: normalizeAvailableLCodeMode(settings.mode.current),
      options: getLCodeAgentModeSelectOptions(),
    },
  ];
  if (settings.thoughtLevel.enabled) {
    configOptions.push({
      id: THOUGHT_LEVEL_CONFIG_ID,
      name: "Thought Level",
      category: "thought_level",
      type: "select",
      currentValue: resolveSettingsThoughtLevelCurrentValue(settings.thoughtLevel) ?? "",
      options: settings.thoughtLevel.available.map((level) => ({
        value: level.value,
        name: level.label,
        description: level.description,
      })),
    });
  }
  return configOptions;
}

export function lcodeWorkspacePresentationToConfigOptions(
  mode: LCodeSessionMode,
): LCodeConfigOption[] {
  return [
    {
      id: MODE_CONFIG_ID,
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: normalizeAvailableLCodeMode(mode),
      options: getLCodeAgentModeSelectOptions(),
    },
  ];
}

function resolveSettingsThoughtLevelCurrentValue(
  thoughtLevel: LCodeSessionSettingsState["thoughtLevel"],
): string | undefined {
  const thoughtLevelValues = new Set(thoughtLevel.available.map((level) => level.value));
  const currentThoughtLevel =
    thoughtLevel.current && thoughtLevelValues.has(thoughtLevel.current)
      ? thoughtLevel.current
      : undefined;
  const defaultThoughtLevel =
    thoughtLevel.defaultLevel && thoughtLevelValues.has(thoughtLevel.defaultLevel)
      ? thoughtLevel.defaultLevel
      : undefined;
  // LCode Protocol 的 defaultLevel 是模型事实，current 为空时表示用户尚未显式修改。
  // 实时模型状态事件也要投影默认值，否则工具栏会拿到空 currentValue，出现没有档位被选中的 UI。
  return currentThoughtLevel ?? defaultThoughtLevel ?? thoughtLevel.available[0]?.value;
}

export function lcodeSessionSnapshotToTaskMeta(snapshot: LCodeSessionStateSnapshot): LCodeTaskMeta {
  return {
    taskId: snapshot.session.sessionId,
    traceId: generateTraceId(snapshot.session.sessionId),
    title: deriveTitleFromSnapshot(snapshot),
    workspacePath: snapshot.session.workspace.workspacePath,
    workspaceIdentity: snapshot.session.workspace.workspaceIdentity,
    createdAt: snapshot.session.createdAt,
    updatedAt: snapshot.session.updatedAt,
    mode: fromLCodeMode(snapshot.session.mode),
    model: formatModelPickerValue(resolveTaskMetaModelSelectionFromSnapshot(snapshot)),
    thoughtLevel: snapshot.settings.thoughtLevel.current,
    provider: LCODE_AGENT_PROVIDER,
    status: deriveLCodeTaskStatusFromSessionSnapshot(snapshot),
    lastError: snapshot.projection.lastError
      ? {
          code: snapshot.projection.lastError.code ?? snapshot.projection.lastError.type,
          ...(snapshot.projection.lastError.detail
            ? { detail: snapshot.projection.lastError.detail }
            : {}),
          ...(snapshot.projection.lastError.attribution
            ? { attribution: snapshot.projection.lastError.attribution }
            : {}),
          message: snapshot.projection.lastError.message,
        }
      : undefined,
    target: snapshot.projection.target
      ? fromLCodeGoal(snapshot.projection.target)
      : snapshot.projection.target,
  };
}

function deriveTitleFromSnapshot(snapshot: LCodeSessionStateSnapshot): string {
  return resolveLCodeVisibleSessionTitle({
    title: snapshot.session.title,
    messages: snapshot.messages,
    target: snapshot.projection.target,
  });
}

function fromLCodeMode(mode: LCodeSessionMode): LCodeTaskMode {
  return mode === "build" ? "build" : mode;
}

function normalizeAvailableLCodeMode(mode: LCodeSessionMode): string {
  return LCODE_AGENT_MODE_ID_SET.has(mode) ? mode : "build";
}

function getLCodeAgentModeSelectOptions(): NonNullable<LCodeConfigOption["options"]> {
  return LCODE_AGENT_MODE_OPTIONS.map((mode) => ({
    value: mode.id,
    name: mode.name,
    description: mode.description,
  }));
}

function fromLCodeGoal(goal: unknown): LCodeTaskGoal {
  const record = asRecord(goal);
  const time = asRecord(record.time);
  const status = stringValue(record.status);
  return {
    sessionID: stringValue(record.sessionID) ?? stringValue(record.sessionId) ?? "",
    targetID: stringValue(record.targetID) ?? stringValue(record.targetId) ?? "",
    objective: stringValue(record.objective) ?? "",
    summaryTitle: stringValue(record.summaryTitle) ?? null,
    status: isLCodeTaskGoalStatus(status) ? status : "active",
    tokenBudget: typeof record.tokenBudget === "number" ? record.tokenBudget : null,
    tokensUsed: numberValue(record.tokensUsed) ?? 0,
    timeUsedSeconds: numberValue(record.timeUsedSeconds) ?? 0,
    activeInputId: stringValue(record.activeInputId) ?? null,
    activeRunStartedAtMs: numberValue(record.activeRunStartedAtMs) ?? null,
    activeRunLastSeenAtMs: numberValue(record.activeRunLastSeenAtMs) ?? null,
    time: {
      created: numberValue(time.created) ?? numberValue(record.createdAt) ?? 0,
      updated: numberValue(time.updated) ?? numberValue(record.updatedAt) ?? 0,
    },
  };
}

function isLCodeTaskGoalStatus(status: string | undefined): status is LCodeTaskGoal["status"] {
  return (
    status === "active" ||
    status === "paused" ||
    status === "budget_limited" ||
    status === "complete"
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
