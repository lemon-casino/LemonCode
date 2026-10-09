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
 * - 执行方式与提交审核是既有配置，只有用户在本步真正选过才写入，
 *   否则跳过或未走到本步都可能把用户已配好的值静默重置回默认。
 */
export function buildOnboardingSettingsPatch({
  occupation,
  mode,
  memory,
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
  suggestions: boolean;
  preferencesSkipped: boolean;
  executionEdited: boolean;
  executionMode: SessionExecutionMode;
  reviewMode: GitCommitReviewMode;
  skippedFinalStep: boolean;
}): Record<string, unknown> {
  const preferencesAnswered = !preferencesSkipped;
  return {
    onboardingOccupation: occupation ?? "other",
    memoryEnabled: preferencesAnswered && memory,
    proactiveSuggestionsEnabled: preferencesAnswered && mode === "office" && suggestions,
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
  suggestions,
  preferencesSkipped,
  completedAt,
}: {
  occupation: OccupationValue | null;
  mode: InterfaceMode | null;
  memory: boolean;
  suggestions: boolean;
  preferencesSkipped: boolean;
  completedAt: string;
}): OnboardingRecordEntryInput {
  const preferencesAnswered = !preferencesSkipped;
  return {
    occupation,
    interfaceMode: mode,
    memoryEnabled: preferencesAnswered ? memory : null,
    proactiveSuggestionsEnabled: preferencesAnswered ? mode === "office" && suggestions : null,
    completedAt,
  };
}
