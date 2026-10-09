import type { GitCommitReviewMode, SessionExecutionMode } from "@lcode/shared";
import { OnboardingChoiceGroup } from "@/onboarding/OnboardingChoiceGroup.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

const EXECUTION_MODES: readonly SessionExecutionMode[] = ["local", "worktree"];
const REVIEW_MODES: readonly GitCommitReviewMode[] = ["off", "draft", "draft-and-review"];

/**
 * 引导的执行与审核页：让用户在进入工作区之前先定下「新会话在哪里执行」与
 * 「任务完成后是否生成提交审核」。两项都写入设置页常规分区使用的同一组
 * AppSettings 字段（`defaultSessionExecutionMode` / `gitCommitReviewMode`），
 * 之后仍可在设置 → 常规中修改，因此这里不维护第二份状态。
 *
 * 选项文案复用设置页既有 key，避免同一语义在两处各写一份翻译。
 */
export function OnboardingExecutionStep({
  executionMode,
  reviewMode,
  saving,
  onExecutionModeSelect,
  onReviewModeSelect,
  t,
}: {
  executionMode: SessionExecutionMode;
  reviewMode: GitCommitReviewMode;
  saving: boolean;
  onExecutionModeSelect: (value: SessionExecutionMode) => void;
  onReviewModeSelect: (value: GitCommitReviewMode) => void;
  t: (key: string) => string;
}) {
  const { intl } = useLCodeIntl();
  return (
    <>
      <OnboardingChoiceGroup
        label={intl.formatMessage({ id: "worktree.defaultMode" })}
        value={executionMode}
        saving={saving}
        columns={2}
        onSelect={onExecutionModeSelect}
        options={EXECUTION_MODES.map((value) => ({
          value,
          label: intl.formatMessage({ id: `worktree.mode.${value}` }),
          description: t(`executionMode.${value}Description`),
        }))}
      />
      <OnboardingChoiceGroup
        label={intl.formatMessage({ id: "settings.gitCommitReviewMode" })}
        value={reviewMode}
        saving={saving}
        onSelect={onReviewModeSelect}
        options={REVIEW_MODES.map((value) => ({
          value,
          label: intl.formatMessage({ id: `settings.gitCommitReviewMode.${value}` }),
          description: t(`reviewMode.${value}Description`),
        }))}
      />
    </>
  );
}
