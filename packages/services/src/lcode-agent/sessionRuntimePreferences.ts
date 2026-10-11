import {
  DEFAULT_LCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  type AppSettings,
  type LCodeSessionRuntimePreferencesResult,
  type LCodeSessionRuntimePreferencesScope,
} from "@lcode/shared";

/** Called by the local Host; remote desktop authority deliberately keeps its existing wire shape. */
export function buildLocalSessionRuntimePreferences(
  settings: Partial<AppSettings>,
  scope: LCodeSessionRuntimePreferencesScope,
): LCodeSessionRuntimePreferencesResult {
  return {
    askUserQuestionAutoResolutionEnabled: settings.askUserQuestionAutoResolutionEnabled !== false,
    nativeSearchEnhancementsEnabled: settings.nativeSearchEnhancementsEnabled !== false,
    memoryEnabled: settings.memoryEnabled === true,
    sessionRecallEnabled: settings.sessionRecallEnabled === true,
    // 旧 Agent 对偏好结果做 strict 校验，profile 缺省时不能新增字段导致兼容报文被拒绝。
    ...(settings.memoryStorageLocation === "workspace"
      ? { memoryStorageLocation: "workspace" as const }
      : {}),
    // 回切 profile 也必须冻结较新版本；否则延迟启动的旧 Runtime 可以回退已准备的位置标记。
    ...((settings.memoryStorageRevision ?? 0) > 0
      ? { memoryStorageRevision: settings.memoryStorageRevision }
      : {}),
    modelContextBudgetStrategy: DEFAULT_LCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
    // user-execution 只消费 Shell；不改变 runtime-materialization 的冻结上下文。
    ...(scope === "user-execution" && settings.integratedTerminalShell
      ? { integratedTerminalShell: settings.integratedTerminalShell }
      : {}),
  };
}
