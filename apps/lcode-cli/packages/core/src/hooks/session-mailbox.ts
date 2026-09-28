import {
  HookEventName,
  type SessionId,
  type SessionMailboxPort,
  type TraceContext,
} from "@lcode/contracts";
import type { HookRegistration } from "./types.js";

const MAILBOX_DRAIN_LIMIT = 20;

export function createSessionMailboxHookRegistrations(options: {
  enqueuePendingInput?: (input: string, traceContext: TraceContext) => Promise<void>;
  mailbox: SessionMailboxPort;
  sessionId: SessionId;
}): HookRegistration[] {
  const callback: HookRegistration["callback"] = async (input, context) => {
    const messages = await options.mailbox.drainUnread(
      { sessionId: options.sessionId, limit: MAILBOX_DRAIN_LIMIT },
      { signal: context.signal },
    );
    if (messages.length === 0) return undefined;

    if (input.hookEventName === HookEventName.PostToolUse && options.enqueuePendingInput) {
      for (const message of messages) {
        await options.enqueuePendingInput(formatMailboxMessages([message]), {
          sessionId: options.sessionId,
          traceId: input.traceId,
          turnId: input.turnId,
        });
      }
      return undefined;
    }

    const additionalContext = formatMailboxMessages(messages);
    return {
      ...(input.hookEventName === HookEventName.Stop ? { continue: true } : {}),
      hookSpecificOutput: {
        additionalContext,
        hookEventName: input.hookEventName,
      },
    };
  };

  return [HookEventName.UserPromptSubmit, HookEventName.PostToolUse, HookEventName.Stop].map(
    (event) => ({
      callback,
      descriptor: {
        clientVisible: false,
        commandDisplay: "Session mailbox",
        executionMode: "foreground",
        executionType: "process",
        sourceKind: "internal",
        timeoutMs: 60_000,
      },
      event,
      source: "builtin.sessionMailbox.drain",
    }),
  );
}

function formatMailboxMessages(
  messages: Awaited<ReturnType<SessionMailboxPort["drainUnread"]>>,
): string {
  return messages
    .map((message) =>
      [
        `<session-message source="mailbox" message_id="${escapeAttr(message.messageId)}" from_session="${escapeAttr(message.fromSessionId)}" created_at="${escapeAttr(message.createdAt)}">`,
        "For reference only. Verify against raw source before acting.",
        "",
        message.content,
        "</session-message>",
      ].join("\n"),
    )
    .join("\n\n");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
