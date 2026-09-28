import { useMemo } from "react";
import type { LCodeConfigOption } from "@lcode/shared";
import { selectWorkspaceLCodeState, useLCodeSessionStore } from "@/store/lcodeSessionStore.js";

/**
 * 子代理模型的 provider 名从哪儿来：会话的模型清单
 * （workspace configOptions 里 category === "model" 的那一项）已经带着
 * `modelProviderId` / `modelProviderName`，不必为一行字再开第二份 provider 目录。
 *
 * 只给**名字**，不给 id：`modelProviderName` 在没有 providerLabel 时会退回 providerId 本身
 * （见 lcodeSessionSettingsToConfigOptions），那种「名字」在这里就当作没有——屏幕上绝不出现
 * providerId（团队套餐的它是一个 UUID）。
 */
function workflowSubagentProviderNameLookup(
  configOptions: readonly LCodeConfigOption[] | null | undefined,
): ((providerId: string) => string | undefined) | undefined {
  const entries = configOptions?.find((option) => option.category === "model")?.options;
  if (entries === undefined) {
    return undefined;
  }
  const names = new Map<string, string>();
  for (const entry of entries) {
    const providerId = entry.modelProviderId?.trim();
    const providerName = entry.modelProviderName?.trim();
    if (!providerId || !providerName || providerName === providerId) {
      continue;
    }
    if (!names.has(providerId)) {
      names.set(providerId, providerName);
    }
  }
  return names.size === 0 ? undefined : (providerId: string) => names.get(providerId);
}

/**
 * 上面那张表的 hook 形态。workspacePath 缺席（宿主给不出作用域）即没有查找函数——
 * 此时拼名规则退回裸 modelId，这是刻意的兜底，不是缺陷。
 */
export function useWorkflowSubagentModelProviderName(
  workspacePath: string | undefined,
  workspaceIdentity?: string,
): ((providerId: string) => string | undefined) | undefined {
  const configOptions = useLCodeSessionStore((state) =>
    workspacePath === undefined
      ? undefined
      : selectWorkspaceLCodeState(state, workspacePath, workspaceIdentity).configOptions,
  );
  return useMemo(() => workflowSubagentProviderNameLookup(configOptions), [configOptions]);
}
