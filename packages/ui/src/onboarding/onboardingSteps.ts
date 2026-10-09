/**
 * 引导向导的步骤序号。四步：工作方向 → UI 模式 → 助手偏好 → 执行与审核。
 * 步骤类型单独放这里，避免组件与遥测各自写一份 `0 | 1 | 2 | 3` 字面量联合。
 */
export type OnboardingStep = 0 | 1 | 2 | 3;

/** 引导总步数，供进度指示器渲染。 */
export const ONBOARDING_STEP_COUNT = 4;

/** 最后一步：提交即保存全部偏好。 */
export const ONBOARDING_LAST_STEP: OnboardingStep = 3;
