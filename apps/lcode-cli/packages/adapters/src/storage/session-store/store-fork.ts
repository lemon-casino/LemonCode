import type {
  CreateSessionInput,
  ForkCommitBundle,
  ForkChildSessionMetadata,
  SessionEntryInfo,
  SessionId,
  SessionInfo,
} from "@lcode/contracts";
import type { SqliteStoreAccess } from "./store-access.js";
import * as sessionRepository from "./repositories/sessions.js";
import * as sessionEntryRepository from "./repositories/session-entries.js";
import * as messageRepository from "./repositories/messages.js";
import * as sessionInputRepository from "./repositories/session-inputs.js";
import { cloneSessionTargetForFork } from "../session-target.js";

function forkChildSessionId(entry: SessionEntryInfo): SessionId | null {
  if (!entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) return null;
  const ack = (entry.data as Record<string, unknown>).ack;
  if (!ack || typeof ack !== "object" || Array.isArray(ack)) return null;
  const result = (ack as Record<string, unknown>).result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const sessionId = (result as Record<string, unknown>).sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? (sessionId as SessionId) : null;
}

function assertForkBundleChildLocal(bundle: ForkCommitBundle): void {
  const childId = String(bundle.child.id);
  const commandResult = bundle.commandFact.ack.result as unknown;
  const result =
    commandResult && typeof commandResult === "object" && !Array.isArray(commandResult)
      ? (commandResult as Record<string, unknown>)
      : null;
  const sessionId = typeof result?.sessionId === "string" ? result.sessionId.trim() : "";
  const isForkResult =
    result?.type === "forkAssistant" ||
    result?.type === "createSelectionSideSession" ||
    (result?.type === "editUserQuery" && result.disposition === "fork");
  if (!isForkResult || !sessionId || sessionId !== childId) {
    // 缺失或非 fork 的 command result 会留下无法重放到 child 的幂等事实。
    throw new Error("Fork bundle command result is missing, invalid, or not child-local");
  }
  const messageIds = new Set(bundle.messages.map((message) => String(message.info.id)));
  const assertMessage = (value: unknown, field: string) => {
    if (typeof value === "string" && !messageIds.has(value)) {
      throw new Error(`Fork bundle ${field} is not child-local: ${value}`);
    }
  };
  const targetIds = new Set<string>();
  if (bundle.goal) targetIds.add(bundle.goal.source.targetID);
  for (const message of bundle.messages) {
    if (String(message.info.sessionID) !== childId) {
      throw new Error("Fork bundle message session is not child-local");
    }
    if (message.info.role === "assistant" && !messageIds.has(String(message.info.parentID))) {
      throw new Error("Fork bundle assistant parent is not child-local");
    }
    const anchor = message.info.anchor;
    for (const id of anchor?.orderedMessageIds ?? []) {
      assertMessage(id, "anchor orderedMessageId");
    }
    assertMessage(anchor?.boundaryMessageId, "anchor boundaryMessageId");
    if (anchor?.goalBoundary?.kind === "snapshot") {
      if (String(anchor.goalBoundary.target.sessionID) !== childId) {
        throw new Error("Fork bundle anchor goal session is not child-local");
      }
      targetIds.add(anchor.goalBoundary.target.targetID);
    }
    for (const part of message.parts) {
      if (
        String(part.sessionID) !== childId ||
        String(part.messageID) !== String(message.info.id)
      ) {
        throw new Error("Fork bundle part owner is not child-local");
      }
      if (part.type === "timeline") {
        assertMessage(part.anchorMessageId, "timeline anchorMessageId");
        if (part.timelineType === "context_compaction") {
          assertMessage(part.summaryMessageId, "timeline summaryMessageId");
        }
        if (part.timelineType === "goal_verification") targetIds.add(part.targetId);
      }
      if (part.type === "compaction") {
        assertMessage(part.tail_start_id, "compaction tail_start_id");
        assertMessage(part.summaryMessageId, "compaction summaryMessageId");
        const boundary = part.compactBoundary;
        assertMessage(boundary?.lastSummarizedMessageId, "compact lastSummarizedMessageId");
        for (const id of boundary?.summaryMessageIds ?? []) {
          assertMessage(id, "compact summaryMessageId");
        }
        for (const id of boundary?.attachmentMessageIds ?? []) {
          assertMessage(id, "compact attachmentMessageId");
        }
        for (const id of boundary?.hookResultMessageIds ?? []) {
          assertMessage(id, "compact hookResultMessageId");
        }
        assertMessage(boundary?.preservedSegment?.headMessageId, "compact preserved head");
        assertMessage(boundary?.preservedSegment?.anchorMessageId, "compact preserved anchor");
        assertMessage(boundary?.preservedSegment?.tailMessageId, "compact preserved tail");
      }
      if (part.type === "tool" && part.state.status === "completed") {
        for (const attachment of part.state.attachments ?? []) {
          if (
            String(attachment.sessionID) !== childId ||
            String(attachment.messageID) !== String(message.info.id)
          ) {
            throw new Error("Fork bundle tool attachment owner is not child-local");
          }
        }
      }
    }
  }
  if (bundle.goal && String(bundle.goal.source.sessionID) !== childId) {
    throw new Error("Fork bundle goal session is not child-local");
  }
  for (const entry of bundle.entries) {
    if (String(entry.sessionID) !== childId) {
      throw new Error("Fork bundle verifier entry session is not child-local");
    }
    const data =
      entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)
        ? (entry.data as Record<string, unknown>)
        : {};
    const payload =
      data.payload && typeof data.payload === "object" && !Array.isArray(data.payload)
        ? (data.payload as Record<string, unknown>)
        : {};
    assertMessage(payload.anchorAssistantMessageId, "verifier assistant anchor");
    if (typeof payload.targetId === "string" && !targetIds.has(payload.targetId)) {
      throw new Error("Fork bundle verifier target is not child-local");
    }
  }
}

export const sessionForkMethods = {
  async createForkedSessionWithMetadata(
    this: SqliteStoreAccess,
    input: CreateSessionInput,
    metadata: ForkChildSessionMetadata,
  ): Promise<SessionInfo> {
    this.throwBeforeWrite();
    if (!input.parentID || String(input.parentID) !== metadata.parentSessionId) {
      throw new Error("Fork child metadata parent does not match session parentID");
    }
    const orderedMessageIds = metadata.forkTarget.orderedMessageIds;
    // compact 覆盖首轮 query 时，input 前稳定前缀合法为空；boundaryMessageId 仍记录
    // 被编辑 input，供幂等事实定位，但不会被复制进 child。
    const validBoundary =
      metadata.forkTarget.boundaryMessageId.trim().length > 0 &&
      (orderedMessageIds.length === 0 ||
        orderedMessageIds.at(-1) === metadata.forkTarget.boundaryMessageId);
    if (!metadata.sourceCommandId.trim() || !validBoundary) {
      throw new Error("Fork child metadata is invalid");
    }

    // command key 是 (parentSessionId, sourceCommandId)；session_entry.id 是全库主键，
    // 必须把 parent 纳入 id，避免两个 session 恰好复用 commandId 时互相覆盖事实。
    const entryId = `v4_command_fact:child:${metadata.parentSessionId}:${metadata.sourceCommandId}`;
    this.db.exec("begin immediate");
    try {
      const existing = sessionEntryRepository
        .sessionEntries(this.db, {
          sessionID: input.parentID,
          type: "v4/command_fact",
        })
        .find((entry) => entry.id === entryId);
      if (existing) {
        const childSessionId = forkChildSessionId(existing);
        if (!childSessionId) {
          throw new Error(`Fork child command fact is corrupt: ${entryId}`);
        }
        const child = sessionRepository.getSession(this.db, childSessionId);
        if (!child) {
          throw new Error(`Fork child session is missing: ${childSessionId}`);
        }
        this.db.exec("commit");
        return child;
      }

      const child = sessionRepository.createSession(this.db, input);
      for (const entry of input.initialEntries ?? []) {
        if (entry.sessionID !== child.id)
          throw new Error("Initial session entry must belong to its session");
        sessionEntryRepository.saveSessionEntry(this.db, entry);
      }
      const now = Date.now();
      sessionEntryRepository.saveSessionEntry(this.db, {
        id: entryId,
        sessionID: input.parentID,
        type: "v4/command_fact",
        time: { created: now, updated: now },
        data: {
          source: "child",
          ack: {
            commandId: metadata.sourceCommandId,
            status: "accepted",
            revisionAtDecision: 0,
            result: { type: "forkAssistant", sessionId: String(child.id) },
          },
          metadata,
        },
      });
      this.db.exec("commit");
      return child;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  },

  async commitForkBundle(this: SqliteStoreAccess, bundle: ForkCommitBundle): Promise<SessionInfo> {
    this.throwBeforeWrite();
    const { child, commandFact, initialInput } = bundle;
    if (
      !child.parentID ||
      String(child.parentID) !== commandFact.parentSessionId ||
      (initialInput && String(initialInput.sessionID) !== String(child.id)) ||
      commandFact.ack.commandId !== commandFact.sourceCommandId
    ) {
      throw new Error("Fork commit bundle identity is invalid");
    }
    const entryId = `v4_command_fact:child:${commandFact.parentSessionId}:${commandFact.sourceCommandId}`;
    this.db.exec("begin immediate");
    try {
      const existing = sessionEntryRepository
        .sessionEntries(this.db, {
          sessionID: child.parentID,
          type: "v4/command_fact",
        })
        .find((entry) => entry.id === entryId);
      if (existing) {
        const existingChildId = forkChildSessionId(existing);
        const existingChild = existingChildId
          ? sessionRepository.getSession(this.db, existingChildId)
          : null;
        if (!existingChild) throw new Error(`Fork bundle command fact is corrupt: ${entryId}`);
        this.db.exec("commit");
        return existingChild;
      }

      assertForkBundleChildLocal(bundle);
      const persistedChild = sessionRepository.createSession(this.db, child);
      this.maybeThrowForkCommitFault("afterChild");
      for (const message of bundle.messages) {
        const messageSource = bundle.copySources?.messages[message.info.id];
        await messageRepository.saveMessage(
          this.db,
          message.info,
          messageSource ? { sessionID: child.parentID, id: messageSource } : undefined,
        );
        for (const part of message.parts) {
          const partSource = bundle.copySources?.parts[part.id];
          await messageRepository.savePart(
            this.db,
            part,
            partSource ? { sessionID: child.parentID, id: partSource } : undefined,
          );
        }
      }
      this.maybeThrowForkCommitFault("afterMessages");
      if (bundle.goal) {
        cloneSessionTargetForFork(this.db, {
          source: bundle.goal.source,
          sessionID: child.id,
          status: bundle.goal.status,
        });
      }
      this.maybeThrowForkCommitFault("afterGoal");
      for (const entry of bundle.entries) {
        sessionEntryRepository.saveSessionEntry(this.db, entry);
      }
      this.maybeThrowForkCommitFault("afterEntries");
      if (initialInput) {
        await sessionInputRepository.saveSessionInput(this.db, initialInput);
      }
      this.maybeThrowForkCommitFault("afterInput");
      const now = Date.now();
      sessionEntryRepository.saveSessionEntry(this.db, {
        id: entryId,
        sessionID: child.parentID,
        type: "v4/command_fact",
        time: { created: now, updated: now },
        data: {
          source: "child",
          ack: commandFact.ack,
          metadata: commandFact.metadata,
        },
      });
      this.maybeThrowForkCommitFault("afterCommandFact");
      this.maybeThrowForkCommitFault("beforeCommit");
      this.db.exec("commit");
      return persistedChild;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  },
};
