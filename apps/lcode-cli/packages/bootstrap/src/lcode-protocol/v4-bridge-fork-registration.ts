import { type CommandEnvelope } from "@lcode/shared/lcode-protocol-v4";

import { queueItemIdForCommand } from "../lcode-protocol-v4/command-inbox.js";

import { SessionEventType, createEventId } from "@lcode/contracts";

import type { SessionEvent, SessionId } from "@lcode/contracts";

import { registerForkedSession } from "./server-operations.js";

import type {
  LCodeProtocolAgentServerContext,
  LCodeProtocolSessionRecord,
} from "./server-types.js";

export async function recordForkStartFailureBestEffort(
  context: LCodeProtocolAgentServerContext,
  sessionId: string,
  command: Pick<CommandEnvelope, "commandId">,
  error: unknown,
  details: { parentSessionId?: string; registrationRequired?: boolean } = {},
): Promise<void> {
  const store = context.deps.sessionStore;
  const record = context.sessions.get(sessionId);
  const now = Date.now();
  const message = error instanceof Error ? error.message : String(error);
  const warn = (stage: string, failure: unknown) => {
    try {
      context.logger?.warn("fork child post-commit failure recording degraded", {
        commandId: command.commandId,
        error: failure instanceof Error ? failure.message : String(failure),
        forkedSessionId: sessionId,
        parentSessionId: details.parentSessionId,
        stage,
      });
    } catch {
      // 日志 sink 失败也属于 post-commit；durable child/fact 不得因此反转。
    }
  };

  try {
    await store?.settleSessionInput?.({
      id: queueItemIdForCommand(command.commandId),
      sessionID: sessionId as SessionId,
      status: "failed",
      reason: "fault.command.childStartFailed",
    });
  } catch (failure) {
    warn("ledger", failure);
  }
  try {
    await store?.saveSessionEntry?.({
      id: `v4_fork_start_failure:${command.commandId}`,
      sessionID: sessionId as SessionId,
      type: "v4/fork_start_failure",
      time: { created: now, updated: now },
      data: {
        commandId: command.commandId,
        forkedSessionId: sessionId,
        parentSessionId: details.parentSessionId,
        ...(details.registrationRequired ? { registrationRequired: true } : {}),
        retryable: true,
        status: "failed",
        reasonCode: "fault.command.childStartFailed",
        message,
      },
    });
  } catch (failure) {
    warn("entry", failure);
  }
  if (!record) return;
  try {
    const event: SessionEvent = {
      id: createEventId(),
      sessionId: sessionId as SessionId,
      type: SessionEventType.TurnError,
      timestamp: new Date(now),
      traceId: record.traceContext.traceId,
      sequenceNumber: (await record.eventStore.getLatestSequenceNumber(sessionId as SessionId)) + 1,
      payload: {
        inputId: command.commandId,
        turnPhase: "fork_child_start",
        error: {
          type: "fault.command.childStartFailed",
          message,
          retryable: true,
        },
      },
    };
    const persisted = await record.eventStore.append(event);
    context.v4Gateway?.ingest(sessionId, persisted);
  } catch (failure) {
    warn("event", failure);
  }
}

/**
 * Fork bundle commit 是命令 PONR；后续 catalog/model/resume/snapshot 仅恢复 runtime 可达性。
 * 该阶段失败必须留下可重试事实与 warning，但不能把 durable accepted child 反转成 failed。
 */
export async function registerCommittedForkBestEffort(
  context: LCodeProtocolAgentServerContext,
  record: LCodeProtocolSessionRecord,
  fork: Parameters<typeof registerForkedSession>[2],
  options: Parameters<typeof registerForkedSession>[3] & { commandId: string },
  register: typeof registerForkedSession = registerForkedSession,
): Promise<void> {
  const { commandId, ...registrationOptions } = options;
  try {
    await register(context, record, fork, registrationOptions);
  } catch (error) {
    const forkedSessionId = String(fork.forkedSessionId);
    const parentSessionId = String(fork.parentSessionId ?? record.app.sessionId);
    await recordForkStartFailureBestEffort(context, forkedSessionId, { commandId }, error, {
      parentSessionId,
      registrationRequired: true,
    });
    try {
      context.logger?.warn("fork child registration failed after durable commit", {
        commandId,
        error: error instanceof Error ? error.message : String(error),
        forkedSessionId,
        parentSessionId,
        retryable: true,
      });
    } catch {
      // logger 自身异常过去会越过 PONR 冒泡，让 gateway 错误 settle 为 failed。
    }
  }
}
