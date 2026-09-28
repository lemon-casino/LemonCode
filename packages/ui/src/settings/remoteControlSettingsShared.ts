// 远程控制设置段各卡片共享的小工具与常量。
// 校验规则与毫秒选项在这里集中，卡片组件不各自持有第二份阈值；
// 域名规范化直接复用 @lcode/shared 的实现，保证 UI 预检与 Main/Worker 的口径一致。
import { startUserAction, type UserActionTrigger } from "@/lib/userActionTelemetry.js";
import { toast } from "@/components/ui/toast.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { RemoteControlConfigPatch } from "@/settings/remoteControlBridge.js";

/** 配对链接有效期可选项（ms）；契约默认 300_000（PROTOCOL.md §4.2）。 */
export const PAIRING_TTL_OPTIONS_MS = [300_000, 600_000, 1_800_000];
/** 空闲自动断开可选项（ms）；0 = 从不，是桌面 Main 的本地策略（§3.4）。 */
export const IDLE_DISCONNECT_OPTIONS_MS = [0, 900_000, 1_800_000, 3_600_000, 14_400_000];

/** 当前值不在候选里时动态补一项，避免 Select 显示成空值。 */
export function buildDurationOptions(current: number | undefined, options: number[]): number[] {
  if (current === undefined || options.includes(current)) {
    return options;
  }
  return [...options, current].sort((a, b) => a - b);
}

export function formatDurationMs(ms: number, intl: Pick<IntlInstance, "formatMessage">): string {
  return intl.formatMessage(
    { id: "settings.remoteControl.duration.minutes" },
    { minutes: Math.round(ms / 60_000) },
  );
}

/**
 * 配置提交的统一入口：埋点 + 保存 + 成功提示/失败提示。
 * saveConfig（useRemoteControl）内部以 Main 回读为准；Main 拒绝时回带的 error
 * 会直接展示在 toast 里（例如接入 Key 长度不满足 shared schema 的 32-256 约束）。
 */
export async function commitRemoteControlConfig(options: {
  intl: Pick<IntlInstance, "formatMessage">;
  saveConfig: (
    patch: RemoteControlConfigPatch,
  ) => Promise<{ success: boolean; error?: string }>;
  patch: RemoteControlConfigPatch;
  action: string;
  trigger: UserActionTrigger;
  successMessageId?: string;
  failureStage?: string;
}): Promise<boolean> {
  const trace = startUserAction({
    featureId: "settings.remoteControl",
    action: options.action,
    trigger: options.trigger,
  });
  const result = await options.saveConfig(options.patch);
  if (result.success) {
    trace.complete({ resultSource: "platform_result" });
    if (options.successMessageId) {
      toast(options.intl.formatMessage({ id: options.successMessageId }));
    }
    return true;
  }
  trace.fail({ failureStage: options.failureStage ?? "settings_commit" });
  toast(
    result.error
      ? options.intl.formatMessage(
          { id: "settings.remoteControl.config.saveFailedWithReason" },
          { error: result.error },
        )
      : options.intl.formatMessage({ id: "settings.remoteControl.config.saveFailed" }),
  );
  return false;
}
