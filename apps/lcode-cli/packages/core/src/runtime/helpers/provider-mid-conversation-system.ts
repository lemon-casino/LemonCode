import type {
  ModelInputMessage,
  RuntimeMessageEntry,
  RuntimeMessageMessageEntry,
} from "../../agent/message-history.js";
import {
  isRuntimeAttachmentEntry,
  isKnownSystemReminderSource,
} from "../../agent/message-history.js";
import {
  isMidConversationSystemSource,
  sanitizeSystemReminderBody,
  wrapSystemReminder,
} from "../../system-reminder/source.js";
import { isPresentedInput, type ProviderEntryOrigins } from "./provider-entry-origins.js";

interface PendingMidSystemEntry {
  entry: RuntimeMessageEntry;
  text: string;
}

interface MidSystemProjection {
  fallbackBody: string;
}

interface ProjectedMidSystemMessageEntry extends RuntimeMessageMessageEntry {
  midSystemProjection: MidSystemProjection;
}

export type ProjectedRuntimeMessageEntry = RuntimeMessageEntry | ProjectedMidSystemMessageEntry;

interface MidSystemProjectionResult {
  entries: ProjectedRuntimeMessageEntry[];
}

export function projectMidConversationSystemEntries(
  entries: readonly RuntimeMessageEntry[],
  origins: ProviderEntryOrigins,
): MidSystemProjectionResult {
  const projected: ProjectedRuntimeMessageEntry[] = [];
  const pending: PendingMidSystemEntry[] = [];

  const flushPending = (): void => {
    if (pending.length === 0) return;
    const pendingItems = pending.splice(0);
    const body = pendingItems.map((item) => item.text).join("\n\n");
    const previous = projected.at(-1);

    if (previous && isProjectedMidSystemEntry(previous)) {
      origins.set(previous, [previous, ...pendingItems.map((item) => item.entry)]);
      previous.message = {
        ...previous.message,
        content: `${previous.message.content}\n\n${body}`,
      };
      previous.midSystemProjection.fallbackBody = `${previous.midSystemProjection.fallbackBody}\n\n${body}`;
      return;
    }

    if (previous && canAnchorMidConversationSystemAfter(previous)) {
      const systemEntry: ProjectedMidSystemMessageEntry = {
        message: {
          role: "system",
          content: body,
        },
        midSystemProjection: { fallbackBody: body },
      };
      origins.set(
        systemEntry,
        pendingItems.map((item) => item.entry),
      );
      projected.push(systemEntry);
      return;
    }

    projected.push(...pendingItems.map((item) => item.entry));
  };

  for (const entry of entries) {
    // 中途输入是因果边界：不能被普通 reminder 越过，也不能越过后来的 user。
    const hasIncoming = pending.some((item) => isPresentedInput(item.entry));
    const nextIsUser = !isRuntimeAttachmentEntry(entry) && entry.message.role === "user";
    if (pending.length > 0 && (isPresentedInput(entry) || (hasIncoming && nextIsUser)))
      flushPending();
    const projectedText = midConversationSystemText(entry);
    if (projectedText !== undefined) {
      pending.push({ entry, text: projectedText });
      continue;
    }

    if (pending.length > 0 && shouldFlushMidConversationSystemBefore(entry)) {
      flushPending();
    }

    projected.push(entry);
  }

  flushPending();

  return { entries: validateMidConversationSystemPositions(projected, origins) };
}

function midConversationSystemText(entry: RuntimeMessageEntry): string | undefined {
  if (isRuntimeAttachmentEntry(entry)) {
    const source = entry.metadata.source;
    if (!isKnownSystemReminderSource(source)) return undefined;
    if (!isMidConversationSystemSource(source)) return undefined;
    return entry.content;
  }
  return undefined;
}

function shouldFlushMidConversationSystemBefore(entry: RuntimeMessageEntry): boolean {
  if (isRuntimeAttachmentEntry(entry)) return false;
  // pending system reminder 需要等到 assistant 或系统边界再落点，
  // 避免插入同一组 tool results 中间导致 provider-visible 顺序非法。
  return entry.message.role === "assistant" || entry.message.role === "system";
}

function canAnchorMidConversationSystemAfter(entry: ProjectedRuntimeMessageEntry): boolean {
  if (isRuntimeAttachmentEntry(entry)) return false;
  const message = entry.message;
  // mid-conversation system 的合法 anchor 对齐 provider-visible role，
  // model-only user（如目标续跑）仍然是 user 消息，不能因内部 source metadata 被误降级。
  if (message.role === "tool") return true;
  return message.role === "user";
}

function validateMidConversationSystemPositions(
  entries: readonly ProjectedRuntimeMessageEntry[],
  origins: ProviderEntryOrigins,
): ProjectedRuntimeMessageEntry[] {
  const projected: ProjectedRuntimeMessageEntry[] = [];

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (!isProjectedMidSystemEntry(entry)) {
      projected.push(entry);
      continue;
    }

    const previous = projected.at(-1);
    const next = entries[index + 1];
    if (previous && canKeepMidConversationSystemBetween(previous, next)) {
      projected.push(entry);
      continue;
    }

    // mid-conversation system 只有在 provider 合法边界才保留；
    // 其他位置降级为旧的 user system-reminder，避免在请求体中生成非法 role 顺序。
    const fallback: RuntimeMessageEntry = {
      message: {
        role: "user",
        // MCS 正文未经过 user 包装，降级必须自行转义，不能假设 producer 已处理。
        content: wrapSystemReminder(
          sanitizeSystemReminderBody(entry.midSystemProjection.fallbackBody),
        ),
      },
      metadata: { source: "legacy_synthetic" },
    };
    origins.set(fallback, [entry]);
    projected.push(fallback);
  }

  return projected;
}

function canKeepMidConversationSystemBetween(
  previous: ProjectedRuntimeMessageEntry,
  next: ProjectedRuntimeMessageEntry | undefined,
): boolean {
  if (!canAnchorMidConversationSystemAfter(previous)) return false;
  if (!next) return true;
  if (isProjectedMidSystemEntry(next)) return true;
  if (isRuntimeAttachmentEntry(next)) return false;
  return next.message.role === "assistant";
}

function isProjectedMidSystemEntry(
  entry: ProjectedRuntimeMessageEntry | undefined,
): entry is ProjectedMidSystemMessageEntry {
  return Boolean(entry && "midSystemProjection" in entry && entry.midSystemProjection);
}

export function moveLegacySystemRemindersAfterToolResultRun(
  entries: readonly ProjectedRuntimeMessageEntry[],
): ProjectedRuntimeMessageEntry[] {
  // legacy/fallback system-reminder 是普通 user text；
  // 若夹在同一组 tool results 中间，Anthropic 序列化只会合并 role，不会自动把 tool_result 排回 text 前。
  const projected: ProjectedRuntimeMessageEntry[] = [];
  const pendingLegacyReminders: ProjectedRuntimeMessageEntry[] = [];

  const flushPendingLegacyReminders = (): void => {
    if (pendingLegacyReminders.length === 0) return;
    projected.push(...pendingLegacyReminders.splice(0));
  };

  for (const entry of entries) {
    if (
      isLegacySystemReminderEntry(entry) &&
      (pendingLegacyReminders.length > 0 || isToolResultEntry(projected.at(-1)))
    ) {
      pendingLegacyReminders.push(entry);
      continue;
    }

    if (pendingLegacyReminders.length > 0) {
      if (isToolResultEntry(entry)) {
        projected.push(entry);
        continue;
      }
      flushPendingLegacyReminders();
    }

    projected.push(entry);
  }

  flushPendingLegacyReminders();
  return projected;
}

function isLegacySystemReminderEntry(entry: ProjectedRuntimeMessageEntry): boolean {
  if (isRuntimeAttachmentEntry(entry)) return true;
  return entry.message.role === "user" && entry.metadata?.source === "legacy_synthetic";
}

function isToolResultEntry(entry: ProjectedRuntimeMessageEntry | undefined): boolean {
  if (!entry || isRuntimeAttachmentEntry(entry)) return false;
  return entry.message.role === "tool" || isToolResultUserMessage(entry.message);
}

export function isToolResultUserMessage(message: ModelInputMessage): boolean {
  return message.role === "user" && Boolean(message.toolCallId || message.toolName);
}
