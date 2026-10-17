import {
  lcodeProtocolMethods,
  lcodeSessionRuntimePreferencesResultSchema,
  LCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
  type ProjectContextSnapshot,
  type LCodeWorkspaceRef,
} from "@lcode/shared";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";

/** CLI admission 调用 Host 项目 owner；结果只随该 input 固定，不保存在 renderer 或第二个接受队列。 */
export async function resolveAdmissionProjectContext(
  context: LCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<ProjectContextSnapshot | undefined> {
  const record = context.sessions.get(sessionId);
  if (!record) throw new Error("Project context requires an existing session record");
  return requestProjectContextForWorkspace(
    context,
    record.workspace,
    sessionId,
    record.traceContext.traceId,
  );
}
export async function requestProjectContextForWorkspace(
  context: Pick<LCodeProtocolAgentServerContext, "requestClient">,
  workspace: LCodeWorkspaceRef,
  sessionId: string,
  traceId?: string,
): Promise<ProjectContextSnapshot | undefined> {
  const response = await context.requestClient(
    lcodeProtocolMethods.sessionRequestRuntimePreferences,
    {
      sessionId,
      scope: "project-admission",
      projectContext: { version: 1, workspace },
    },
    lcodeSessionRuntimePreferencesResultSchema,
    {
      timeoutMs: LCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
      ...(traceId ? { trace: { traceId } } : {}),
    },
  );
  if (response.projectContext === undefined)
    throw new Error(
      "This Host does not support project collaboration context. Update the Host before sending.",
    );
  return response.projectContext ?? undefined;
}
