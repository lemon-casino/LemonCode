import type {
  GitCommitReviewMode,
  OnboardingRecordEntryInput,
  SessionExecutionMode,
} from "@lcode/shared";
import type { InterfaceMode } from "@/lib/interfaceMode.js";
import type { OccupationValue } from "@/onboarding/occupationOptions.js";

/**
 * 引导保存时写入 AppSettings 的补丁。
 *
 * 两条语义边界（从 OccupationOnboarding 抽出，便于单测且控制组件行数）：
 * - 偏好页被跳过 → 记忆/推荐落保守默认 false，与"明确选了关"的区别只留在引导记录里；
 * - 执行方式、提交审核与自动历史召回是既有配置，只有用户在本步真正改过才写入，
 *   否则跳过或未走到本步都可能把用户已配好的值静默重置。
 *
 * `sessionRecall` 的 null 表示"本次未作答"（页面被跳过或用户没动过这个勾选框），
 * 与记录里"跳过记 null"同一套词汇；未作答就不写入，交由既有配置保持原值。
 */
export function buildOnboardingSettingsPatch({
  occupation,
  mode,
  memory,
  sessionRecall,
  suggestions,
  preferencesSkipped,
  executionEdited,
  executionMode,
  reviewMode,
  skippedFinalStep,
}: {
  occupation: OccupationValue | null;
  mode: InterfaceMode | null;
  memory: boolean;
  sessionRecall: boolean | null;
  suggestions: boolean;
  preferencesSkipped: boolean;
  executionEdited: boolean;
  executionMode: SessionExecutionMode;
  reviewMode: GitCommitReviewMode;
  skippedFinalStep: boolean;
}): Record<string, unknown> {
  const preferencesAnswered = !preferencesSkipped;
  // 未作答（null）不写入：既有配置保持原值，避免引导静默关掉已开启的召回。
  const sessionRecallPatch =
    preferencesAnswered && sessionRecall !== null ? { sessionRecallEnabled: sessionRecall } : {};
  return {
    onboardingOccupation: occupation ?? "other",
    memoryEnabled: preferencesAnswered && memory,
    proactiveSuggestionsEnabled: preferencesAnswered && mode === "office" && suggestions,
    ...sessionRecallPatch,
    ...(executionEdited && !skippedFinalStep
      ? { defaultSessionExecutionMode: executionMode, gitCommitReviewMode: reviewMode }
      : {}),
  };
}

/** 本地引导记录条目；被跳过的页记 null，与"明确选择"区分。 */
export function buildOnboardingRecordEntry({
  occupation,
  mode,
  memory,
  sessionRecall,
  suggestions,
  preferencesSkipped,
  completedAt,
}: {
  occupation: OccupationValue | null;
  mode: InterfaceMode | null;
  memory: boolean;
  sessionRecall: boolean | null;
  suggestions: boolean;
  preferencesSkipped: boolean;
  completedAt: string;
}): OnboardingRecordEntryInput {
  const preferencesAnswered = !preferencesSkipped;
  return {
    occupation,
    interfaceMode: mode,
    memoryEnabled: preferencesAnswered ? memory : null,
    // 与 sessionRecallEnabled 的写入边界一致：没改动就记 null（未作答），
    // 不假装用户选了关，换号回填时才不会把设置里的已开启值顶掉。
    sessionRecallEnabled: preferencesAnswered ? sessionRecall : null,
    proactiveSuggestionsEnabled: preferencesAnswered ? mode === "office" && suggestions : null,
    completedAt,
  };
}
