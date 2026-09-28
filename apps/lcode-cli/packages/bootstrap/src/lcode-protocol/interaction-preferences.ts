import { lcodeWorkspaceUpdateInteractionPreferencesParamsSchema } from "@lcode/shared";
import { parseParams, type LCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * 应用 workspace 交互偏好。CLI 进程按 workspace 隔离，因此 registry 是该 workspace
 * 内主任务、后台任务与子 Agent 共用的权威 gate。
 */
export async function updateInteractionPreferences(
  context: LCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(lcodeWorkspaceUpdateInteractionPreferencesParamsSchema, rawParams);
  const enabled = params.preferences.askUserQuestionAutoResolutionEnabled;
  context.appRuntimePreferences.askUserQuestionAutoResolutionEnabled = enabled;
  const snoozedInteractionCount =
    await context.v4Interactions.setAskUserQuestionAutoResolutionEnabled(enabled);

  return {
    workspace: params.workspace,
    askUserQuestionAutoResolutionEnabled: enabled,
    snoozedInteractionCount,
  };
}
