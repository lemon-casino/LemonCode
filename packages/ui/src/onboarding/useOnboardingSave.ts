import { useCallback, useRef, useState } from "react";
import type {
  GitCommitReviewMode,
  OnboardingRecordEntryInput,
  SessionExecutionMode,
} from "@lcode/shared";
import type { InterfaceMode } from "@/lib/interfaceMode.js";
import type { OccupationValue } from "@/onboarding/occupationOptions.js";
import {
  buildOnboardingRecordEntry,
  buildOnboardingSettingsPatch,
} from "@/onboarding/onboardingSavePatch.js";
import { logger } from "@/logger.js";

/** 追加本地引导记录（userId 由 host 补全）；channel 缺失挂起时 5 秒超时按写失败处理。 */
async function appendWithTimeout(
  appendRecord: (deviceMid: string, entry: OnboardingRecordEntryInput) => Promise<void>,
  deviceId: string,
  entry: OnboardingRecordEntryInput,
): Promise<void> {
  await Promise.race([
    appendRecord(deviceId, entry),
    new Promise((_, reject) => setTimeout(() => reject(new Error("appendRecord timeout")), 5000)),
  ]);
}

/**
 * 引导的保存编排：写设置 → 上报退出埋点 → 追加本地记录。
 *
 * 从 OccupationOnboarding 抽出以控制文件行数。状态仍由外层持有，这里只做写入顺序，
 * 因此不复制任何偏好事实。偏好页是否被跳过、执行配置是否被改过都通过 ref 读取，
 * 避免把它们的当前值冻结进 useCallback 依赖。
 */
export function useOnboardingSave({
  update,
  occupation,
  mode,
  memory,
  sessionRecall,
  suggestions,
  executionMode,
  reviewMode,
  executionEditedRef,
  preferencesSkippedRef,
  setInterfaceMode,
  onSaved,
  onboardingRecord,
  deviceId,
  markOnboarded,
  captureEnd,
  t,
}: {
  update: (patch: Record<string, unknown>) => Promise<void>;
  occupation: OccupationValue | null;
  mode: InterfaceMode | null;
  memory: boolean;
  /** null 表示本次未作答自动历史召回（未改动），保存时不写该字段。 */
  sessionRecall: boolean | null;
  suggestions: boolean;
  executionMode: SessionExecutionMode;
  reviewMode: GitCommitReviewMode;
  executionEditedRef: { current: boolean };
  preferencesSkippedRef: { current: boolean };
  setInterfaceMode: (mode: InterfaceMode) => void;
  onSaved: (options: { skippedFinalStep: boolean }) => void;
  onboardingRecord: {
    appendRecord: (deviceMid: string, entry: OnboardingRecordEntryInput) => Promise<void>;
  } | null;
  deviceId: string;
  markOnboarded: () => void;
  captureEnd: (action: "start" | "skip" | "close", text: string) => () => void;
  t: (key: string) => string;
}) {
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState(false);

  const save = useCallback(
    async ({ skippedFinalStep = false }: { skippedFinalStep?: boolean } = {}) => {
      if (savingRef.current) return;
      savingRef.current = true;
      const reportEnd = captureEnd(
        skippedFinalStep ? "skip" : "start",
        t(skippedFinalStep ? "skip" : "start"),
      );
      setSaving(true);
      setError(false);
      try {
        if (mode) setInterfaceMode(mode);
        logger.info("[occupation-onboarding] 保存偏好", { interfaceMode: mode });
        await update(
          buildOnboardingSettingsPatch({
            occupation,
            mode,
            memory,
            sessionRecall,
            suggestions,
            preferencesSkipped: preferencesSkippedRef.current,
            executionEdited: executionEditedRef.current,
            executionMode,
            reviewMode,
            skippedFinalStep,
          }),
        );
        reportEnd();
        onSaved({ skippedFinalStep });
        logger.info("[occupation-onboarding] 偏好保存完成", { interfaceMode: mode });
        if (onboardingRecord) {
          try {
            // 追加本地引导记录（userId 由 host 按登录态补全），后续上传服务器。
            // appendRecord 走 RPC，channel 缺失时会挂起导致保存按钮永远转圈，加超时保护。
            await appendWithTimeout(
              (mid, entry) => onboardingRecord.appendRecord(mid, entry),
              deviceId,
              buildOnboardingRecordEntry({
                occupation,
                mode,
                memory,
                sessionRecall,
                suggestions,
                preferencesSkipped: preferencesSkippedRef.current,
                completedAt: new Date().toISOString(),
              }),
            );
            markOnboarded();
          } catch (cause) {
            // 偏好已保存成功，记录写失败只留 warn，不打断用户；下次启动按记录会再次触发引导。
            logger.warn("[occupation-onboarding] 写入引导记录失败", { error: String(cause) });
          }
        }
      } catch (cause) {
        logger.warn("[occupation-onboarding] 保存偏好失败", { error: String(cause) });
        setError(true);
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [
      captureEnd,
      deviceId,
      executionEditedRef,
      executionMode,
      markOnboarded,
      memory,
      mode,
      occupation,
      onboardingRecord,
      onSaved,
      preferencesSkippedRef,
      reviewMode,
      sessionRecall,
      setInterfaceMode,
      suggestions,
      t,
      update,
    ],
  );

  return { save, saving, error, setError, savingRef };
}
