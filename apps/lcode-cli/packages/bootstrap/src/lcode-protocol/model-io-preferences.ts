import { lcodeWorkspaceUpdateModelIoPreferencesParamsSchema } from "@lcode/shared";
import { parseParams, type LCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * ModelIO 写盘策略是 App 全局偏好，但每个 resident session 持有独立 adapter。
 * 因此协议层同时缓存偏好供未来 session 继承，并立即更新已有 session，避免新旧任务行为分裂。
 */
export async function updateModelIoPreferences(
  context: LCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(lcodeWorkspaceUpdateModelIoPreferencesParamsSchema, rawParams);
  const enabled = params.preferences.fullRetentionEnabled;
  context.appRuntimePreferences.modelIoFullRetentionEnabled = enabled;

  let updatedSessionCount = 0;
  for (const record of context.sessions.values()) {
    if (!record.app.setModelIoFullRetentionEnabled) continue;
    record.app.setModelIoFullRetentionEnabled(enabled);
    updatedSessionCount += 1;
  }

  return {
    workspace: params.workspace,
    fullRetentionEnabled: enabled,
    updatedSessionCount,
  };
}
