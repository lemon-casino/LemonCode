import type { SessionTaskType } from "@lcode/contracts";
import type { CommandEnvelope } from "@lcode/shared/lcode-protocol-v4";
import { isConversationInputAdmissionCommand } from "./v4-bridge-admission-input.js";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";

/** 两类 child 的通用执行输入均只读，workflow 控制仍由专用 run owner 接受。 */
export function isReadOnlyChildTaskType(taskType: SessionTaskType | undefined): boolean {
  return taskType === "subagent_child" || taskType === "workflow_child";
}

export function isChildExecutionCommand(type: CommandEnvelope["type"]): boolean {
  return isConversationInputAdmissionCommand(type) || CHILD_EXECUTION_COMMANDS.has(type);
}

const CHILD_EXECUTION_COMMANDS: ReadonlySet<CommandEnvelope["type"]> = new Set([
  "resumeGoal",
  "pauseGoal",
  "sendQueuedNow",
  "forkAssistant",
  "forkSession",
  "createSelectionSideSession",
  "switchModelConfig",
  "switchCollaborationMode",
  "setFollowupMode",
  "setAutoDrain",
  "editQueueItem",
  "reorderQueueItem",
  "deleteQueueItem",
]);

export async function readChildInputFault(
  context: LCodeProtocolAgentServerContext,
  sessionId: string,
) {
  const taskType =
    context.sessions.get(sessionId)?.taskType ??
    (await context.deps.sessionStore?.getSession(sessionId as import("@lcode/contracts").SessionId))
      ?.taskType;
  return isReadOnlyChildTaskType(taskType)
    ? {
        reasonCode: "guard.subagentReadOnly",
        message: "Child sessions are read-only; use workflow task controls",
      }
    : null;
}
