import { useOnboardingTelemetry } from "@/onboarding/useOnboardingTelemetry.js";
import { OnboardingHeader } from "@/onboarding/OnboardingHeader.js";
import { OccupationOnboardingVisual } from "@/onboarding/OccupationOnboardingVisual.js";
import { occupations, type OccupationValue } from "@/onboarding/occupationOptions.js";
import { OnboardingModeSelector } from "@/onboarding/OnboardingModeSelector.js";
import { OnboardingPreferencesStep } from "@/onboarding/OnboardingPreferencesStep.js";
import { OnboardingExecutionStep } from "@/onboarding/OnboardingExecutionStep.js";
import { OnboardingOccupationGrid } from "@/onboarding/OnboardingOccupationGrid.js";
import { useOnboardingTrigger } from "@/onboarding/useOnboardingTrigger.js";
import { ONBOARDING_LAST_STEP, type OnboardingStep } from "@/onboarding/onboardingSteps.js";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useSettings } from "@/hooks/useSettingService.js";
import { useOnboardingRecordService } from "@/hooks/useOnboardingRecordService.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useEffectiveShortcutBindings } from "@/shortcuts/useShortcutBindings.js";
import { useOnboardingShortcuts } from "@/onboarding/useOnboardingShortcuts.js";
import { useOnboardingSave } from "@/onboarding/useOnboardingSave.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { useLCodeStore } from "@/store/StoreProvider.js";
import type { InterfaceMode } from "@/lib/interfaceMode.js";
import { logger } from "@/logger.js";
import { DesktopWindowControls } from "@/DesktopWindowControls.js";
import type { OnboardingRecordEntry } from "@lcode/shared";
import {
  resolveGlobalGitCommitReviewMode,
  type GitCommitReviewMode,
  type SessionExecutionMode,
} from "@lcode/shared";

export function OccupationOnboarding({
  children,
  showWindowControls = false,
  showChildrenWhileLoading = false,
  isMacDesktop,
  isWindowsDesktop,
}: {
  children: ReactNode;
  /** Windows/Linux 自绘窗控：引导全屏覆盖主界面（含标题栏），需在此补最小化/最大化/关闭。 */
  showWindowControls?: boolean;
  /** 独立设置页不依赖引导设置加载，避免应用级引导外层遮住设置内容。 */
  showChildrenWhileLoading?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
}) {
  const { settings, update } = useSettings();
  const platform = usePlatform();
  const onboardingRecord = useOnboardingRecordService();
  const shortcutBindings = useEffectiveShortcutBindings();
  const requested = useLCodeStore((state) => state.newUserOnboardingOpen);
  const setRequested = useLCodeStore((state) => state.setNewUserOnboardingOpen);
  // 登录态变化（useRootOAuthEffects 登录成功后 setUser）时按 userId 重新判定是否触发引导。
  const userId = useLCodeStore((state) => state.user?.id) ?? null;
  const { intl } = useLCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `occupationOnboarding.${key}` });
  const [occupation, setOccupation] = useState<OccupationValue | null>("developer");
  const savedInterfaceMode = useLCodeStore((state) => state.interfaceMode);
  const setInterfaceMode = useLCodeStore((state) => state.setInterfaceMode);
  // 主题的运行时所有者是 store 的 theme/setTheme（spec: specs/ui-theme-modes.md）；
  // 引导只作为第三个选择入口复用同一链路，不新建第二份状态或直写 DOM。
  const theme = useLCodeStore((state) => state.theme);
  const setTheme = useLCodeStore((state) => state.setTheme);
  // mode 为 null 表示模式页被"跳过"（跳过是显式答案，记录里保留 null 而非兜底值）。
  const [mode, setMode] = useState<InterfaceMode | null>(savedInterfaceMode);
  const [step, setStep] = useState<OnboardingStep>(0);
  const preferences = step === 2;
  const execution = step === 3;
  const requestOnboardingDialog = useLCodeStore((state) => state.requestOnboardingDialog);
  const [migration, setMigration] = useState(false);
  const [memory, setMemory] = useState(savedInterfaceMode === "office");
  const [suggestions, setSuggestions] = useState(savedInterfaceMode === "office");
  const suggestionsEditedRef = useRef(false);
  // 偏好页（第 3 步）被单独跳过时，其布尔答案在引导记录里记 null。
  const preferencesSkippedRef = useRef(false);
  // 执行方式与提交审核沿用设置页常规分区的同一组字段，初值取已持久化的生效值，
  // 用户不修改时不产生多余写入。
  const [executionMode, setExecutionMode] = useState<SessionExecutionMode>("local");
  const [reviewMode, setReviewMode] = useState<GitCommitReviewMode>("off");
  const executionEditedRef = useRef(false);
  const [dismissed, setDismissed] = useState(false);
  const [needsOnboarding, markOnboarded] = useOnboardingTrigger({
    onboardingRecord,
    userId,
    hasStoredOccupation: Boolean(settings?.onboardingOccupation),
    update,
  });
  const onboardingVisible = requested || (needsOnboarding === true && !dismissed);
  const captureEnd = useOnboardingTelemetry({
    platform,
    visible:
      Boolean(settings) &&
      onboardingVisible &&
      (requested || needsOnboarding !== null || Boolean(settings?.onboardingOccupation)),
    step,
    occupation,
    mode,
    memory,
    suggestions,
    migration,
  });
  const { save, saving, error, setError, savingRef } = useOnboardingSave({
    update,
    occupation,
    mode,
    memory,
    suggestions,
    executionMode,
    reviewMode,
    executionEditedRef,
    preferencesSkippedRef,
    setInterfaceMode,
    onSaved: ({ skippedFinalStep }) => {
      // 保存成功就是本次引导的终点；本地记录失败不应留下可再次上报的引导页面。
      setStep(0);
      setDismissed(true);
      setRequested(false);
      if (!skippedFinalStep && migration) requestOnboardingDialog("migration");
    },
    onboardingRecord,
    deviceId: platform.getDeviceId(),
    markOnboarded,
    captureEnd,
    t,
  });
  const closeOnboarding = useCallback(() => {
    if (savingRef.current) return;
    captureEnd("close", intl.formatMessage({ id: "occupationOnboarding.close" }))();
    setStep(0);
    setDismissed(true);
    setRequested(false);
  }, [captureEnd, intl, savingRef, setRequested]);
  useOnboardingShortcuts({
    shortcutBindings,
    onboardingVisible,
    saving,
    savedInterfaceMode,
    mode,
    suggestionsEditedRef,
    setInterfaceMode,
    setMode,
    setMemory,
    setSuggestions,
    closeOnboarding,
    setRequested,
  });
  // 引导再次打开（换账号触发 / 快捷键手动打开）时，用该用户在 record 里的最近作答预填，
  // 而不是每次都从写死的默认选项开始；跳过页记 null 的字段落默认值。
  const [latestEntry, setLatestEntry] = useState<OnboardingRecordEntry | null>(null);
  // 预填异步后到时不得覆盖用户已经做出的选择。
  const userEditedRef = useRef(false);
  useEffect(() => {
    if (!onboardingRecord) return;
    let cancelled = false;
    onboardingRecord.getLatestEntry().then(
      (entry) => {
        if (!cancelled) setLatestEntry(entry);
      },
      (cause) => {
        logger.warn("[occupation-onboarding] 读取预填作答失败", { error: String(cause) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [onboardingRecord, userId]);
  const markUserEdited = () => {
    userEditedRef.current = true;
  };

  const applyLatestEntry = () => {
    const entry = latestEntry;
    setStep(0);
    setOccupation(
      entry?.occupation && (occupations as readonly string[]).includes(entry.occupation)
        ? (entry.occupation as OccupationValue)
        : "developer",
    );
    const initialMode = entry?.interfaceMode ?? savedInterfaceMode;
    setMode(initialMode);
    // 编程模式默认关闭主动工作记忆；办公模式才恢复该用户之前的勾选。
    setMemory(initialMode === "office" && (entry?.memoryEnabled ?? true));
    setSuggestions(entry?.proactiveSuggestionsEnabled ?? initialMode === "office");
    // 执行与审核回读当前生效设置：两项都不是"跳过即改配置"的偏好，
    // 用户没动过就不该在保存时被改写。
    setExecutionMode(settings?.defaultSessionExecutionMode ?? "local");
    setReviewMode(resolveGlobalGitCommitReviewMode(settings ?? {}));
    setMigration(false);
    setError(false);
  };
  useEffect(() => {
    if (!requested) return;
    userEditedRef.current = false;
    suggestionsEditedRef.current = false;
    executionEditedRef.current = false;
    preferencesSkippedRef.current = false;
    applyLatestEntry();
    // latestEntry 异步到达时若引导已打开，重新预填一次（用户未交互前覆盖默认值）。
  }, [requested]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!onboardingVisible || userEditedRef.current) return;
    applyLatestEntry();
    // eslint-disable-line react-hooks/exhaustive-deps
  }, [latestEntry]);
  if (!settings) return showChildrenWhileLoading ? <>{children}</> : null;
  // 判定进行中先不渲染，避免引导闪现后立即消失（判定为需引导）或先闪引导再进主界面。
  // 只有疑似首跑（settings 里也没有职业）才等待记录判定；存量用户（已有
  // onboardingOccupation）不等 RPC 直接进主界面，杜绝黑屏。
  // 等待判定期间 showChildrenWhileLoading=true 时仍渲染 children：手机/Web 镜像没有
  // welcome/启动门禁兜底，无条件 null 会得到整页空壳黑屏（specs/mobile-remote-control-cf-workers.md）。
  if (!requested && needsOnboarding === null && !settings.onboardingOccupation) {
    return showChildrenWhileLoading ? <>{children}</> : null;
  }
  if (!onboardingVisible) return <>{children}</>;
  return (
    <main
      aria-label={t("title")}
      data-testid="onboarding-page"
      className="relative flex h-dvh w-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-12 [app-region:drag]" />
      {/* 与 Settings 相同，计入 Workspace 的 4px 外层留白、1px 边框和 8px 内边距。 */}
      {showWindowControls ? (
        <div className="absolute right-1 top-1 z-30 mt-px mr-px flex h-12 items-center px-2">
          <DesktopWindowControls />
        </div>
      ) : null}
      <div className="relative grid min-h-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-2 lg:gap-1 lg:p-1">
        <div className="flex min-h-0 flex-col pt-12 [@media(max-height:740px)]:pt-10">
          <OnboardingHeader
            step={step}
            saving={saving}
            t={t}
            onBack={() => setStep((step === 0 ? 0 : step - 1) as OnboardingStep)}
            onClose={closeOnboarding}
          />
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-4 sm:px-10">
            {/* 自动外边距让短内容居中，长内容从顶部正常滚动，不影响固定导航。 */}
            <div className="mx-auto my-auto w-full max-w-lg shrink-0">
              <section className="flex w-full flex-col">
                <div className="w-full">
                  <h1 className="text-ui-xl font-semibold tracking-tight text-center">
                    {t(
                      execution
                        ? "execution"
                        : preferences
                          ? "preferences"
                          : step === 1
                            ? "modeTitle"
                            : "title",
                    )}
                  </h1>
                  <p className="mx-auto mt-3 max-w-md text-center text-ui-base leading-relaxed text-foreground-subtle">
                    {t(
                      execution
                        ? "executionDescription"
                        : preferences
                          ? "preferencesDescription"
                          : step === 1
                            ? "modeDescription"
                            : "description",
                    )}
                  </p>
                  {step === 1 ? (
                    <OnboardingModeSelector
                      mode={mode}
                      saving={saving}
                      onSelect={(value) => {
                        markUserEdited();
                        // 重选当前编程模式也应清除旧记录带来的默认勾选。
                        setMemory(value === "office");
                        if (value !== mode) {
                          if (value === "office" && !suggestionsEditedRef.current)
                            setSuggestions(true);
                        }
                        setMode(value);
                      }}
                      label={t("modeTitle")}
                      formatLabel={(key) => t(key)}
                    />
                  ) : preferences ? (
                    <OnboardingPreferencesStep
                      mode={mode}
                      theme={theme}
                      memory={memory}
                      suggestions={suggestions}
                      migration={migration}
                      saving={saving}
                      onThemeSelect={(value) => {
                        markUserEdited();
                        // 主题经 store 的 setTheme 立即生效并写入 localStorage；
                        // 不进入 settings 保存，跳过本页也不回退用户已选的主题。
                        setTheme(value);
                      }}
                      onToggle={(key, checked) => {
                        markUserEdited();
                        if (key === "migration") setMigration(checked);
                        else if (key === "memory") setMemory(checked);
                        else {
                          suggestionsEditedRef.current = true;
                          setSuggestions(checked);
                        }
                      }}
                      t={t}
                    />
                  ) : execution ? (
                    <OnboardingExecutionStep
                      executionMode={executionMode}
                      reviewMode={reviewMode}
                      saving={saving}
                      onExecutionModeSelect={(value) => {
                        markUserEdited();
                        executionEditedRef.current = true;
                        setExecutionMode(value);
                      }}
                      onReviewModeSelect={(value) => {
                        markUserEdited();
                        executionEditedRef.current = true;
                        setReviewMode(value);
                      }}
                      t={t}
                    />
                  ) : (
                    <OnboardingOccupationGrid
                      occupation={occupation}
                      saving={saving}
                      onSelect={(value) => {
                        markUserEdited();
                        setOccupation(value);
                      }}
                      label={t("title")}
                      formatLabel={(value) => t(value)}
                    />
                  )}
                  {error ? (
                    <p role="alert" className="mt-4 text-ui-sm text-destructive">
                      {t("error")}
                    </p>
                  ) : null}
                </div>
                <footer className="mt-6 flex flex-col gap-3 [@media(max-height:740px)]:mt-4 [@media(max-height:740px)]:gap-1">
                  <Button
                    variant="link"
                    disabled={saving}
                    className="order-2 h-9 self-center rounded-xl px-3 text-ui-base text-foreground-subtle"
                    onClick={() => {
                      markUserEdited();
                      // 每页的“跳过”只跳过当前页并前进；最后一页的跳过直接完成引导。
                      if (step === ONBOARDING_LAST_STEP) {
                        void save({ skippedFinalStep: true });
                        return;
                      }
                      if (step === 0) setOccupation(null);
                      else if (step === 1) setMode(null);
                      else preferencesSkippedRef.current = true;
                      setStep((step + 1) as OnboardingStep);
                    }}
                  >
                    {t("skip")}
                  </Button>
                  <div className="flex w-full gap-3">
                    <Button
                      disabled={saving || (step === 0 && !occupation)}
                      className="h-11 flex-1 rounded-xl px-5 text-ui-base"
                      onClick={() => {
                        if (step === ONBOARDING_LAST_STEP) void save({});
                        else setStep((step + 1) as OnboardingStep);
                      }}
                    >
                      {t(saving ? "saving" : step === ONBOARDING_LAST_STEP ? "start" : "continue")}
                    </Button>
                  </div>
                </footer>
              </section>
            </div>
          </div>
        </div>
        <OccupationOnboardingVisual
          isMacDesktop={isMacDesktop}
          isWindowsDesktop={isWindowsDesktop}
        />
      </div>
    </main>
  );
}
