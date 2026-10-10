import { createHash } from "node:crypto";
import {
  SessionEventType,
  type SessionEvent,
  type ToolCallStartedPayload,
  type ToolCallResultPayload,
  type ToolCallErrorPayload,
} from "@lcode/contracts";
import {
  beginGoalExecution,
  finishGoalExecution,
  GoalEvidenceAdmissionError,
  type GoalExecutionCapture,
  type GoalEvidenceOwner,
} from "../../goal/evidence.js";
import type { AgentRuntimeInternal } from "../internal.js";

const captures = new WeakMap<
  AgentRuntimeInternal,
  Map<string, { capture: GoalExecutionCapture; generation: number }>
>();
export function runtimeGoalEvidenceOwner(runtime: AgentRuntimeInternal): GoalEvidenceOwner {
  return {
    sessionId: runtime.sessionId,
    workspacePath: runtime.workingDirectory,
    workspaceKey:
      runtime.config.workspaceIdentity?.trim() ||
      runtime.config.workspacePath ||
      runtime.workingDirectory,
    fileSystem: runtime.fileSystemPort,
    store: runtime.sessionStore,
  };
}

export async function observeGoalToolEvent(
  runtime: AgentRuntimeInternal,
  event: SessionEvent,
): Promise<void> {
  if (event.type === SessionEventType.ToolCallStarted) {
    const payload = event.payload as ToolCallStartedPayload;
    if (payload.toolName !== "Bash" || !payload.executionCommand) return;
    const capture = await beginGoalExecution(runtimeGoalEvidenceOwner(runtime), {
      executionId: String(payload.toolCallId),
      source: "Bash",
      command: payload.executionCommand,
      startedAt: event.timestamp.getTime(),
    });
    if (!capture) return;
    const map = captures.get(runtime) ?? new Map();
    // durable head 已推进，不能静默丢弃 capture 后继续执行；未结算 head 保持 incomplete。
    if (map.size >= 256)
      throw new GoalEvidenceAdmissionError("Strict execution capture capacity is exhausted.");
    map.set(String(payload.toolCallId), { capture, generation: runtime.branchGeneration });
    captures.set(runtime, map);
    return;
  }
  if (
    event.type !== SessionEventType.ToolCallResult &&
    event.type !== SessionEventType.ToolCallError
  )
    return;
  const payload = event.payload as ToolCallResultPayload | ToolCallErrorPayload;
  const map = captures.get(runtime);
  const captured = map?.get(String(payload.toolCallId));
  map?.delete(String(payload.toolCallId));
  if (
    !captured ||
    captured.generation !== runtime.branchGeneration ||
    captured.capture.owner.workspacePath !== runtime.workingDirectory
  )
    return;
  const facts = "result" in payload ? payload.result.executionFacts : undefined;
  await finishGoalExecution(captured.capture, {
    exitCode: facts?.exitCode ?? null,
    completedAt: event.timestamp.getTime(),
    cancelled:
      facts?.cancelled === true || ("error" in payload && /cancel/iu.test(payload.error.type)),
    output: facts?.output ?? {
      sha256: createHash("sha256").update("").digest("hex"),
      bytes: 0,
      truncated: false,
      artifactRefs: [],
    },
  });
}
