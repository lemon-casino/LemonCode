import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  CONTEXT_CAPSULE_ENTRY_TYPE,
  CONTEXT_CAPSULE_MAX_PER_SESSION,
  ContextCapsuleSchema,
  contextCapsuleSourcePayload,
  selectActiveSessionTranscript,
  stableContextMessages,
  type ContextCapsule,
  type ContextCapsuleAttachInput,
  type ContextCapsuleCommitResult,
  type SessionId,
  type SessionInfo,
  type MessageWithParts,
} from "@lcode/contracts";
import type { SqliteStoreAccess } from "./store-access.js";
import * as sessions from "./repositories/sessions.js";
import * as entries from "./repositories/session-entries.js";
import * as messages from "./repositories/messages.js";
import * as inputs from "./repositories/session-inputs.js";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function scopeMatches(session: SessionInfo, scope: ContextCapsule["sourceScope"]): boolean {
  return (
    (session.workspaceID?.trim() || undefined) === (scope.workspaceIdentity?.trim() || undefined) &&
    session.directory === scope.directory &&
    session.path === scope.path
  );
}
function sameScope(source: SessionInfo, target: SessionInfo): boolean {
  const sourceIdentity = source.workspaceID?.trim(),
    targetIdentity = target.workspaceID?.trim();
  return sourceIdentity
    ? sourceIdentity === targetIdentity
    : !targetIdentity && resolve(source.directory) === resolve(target.directory);
}
function activeMessages(records: MessageWithParts[], session: SessionInfo): MessageWithParts[] {
  return selectActiveSessionTranscript(records, {
    branchCutAfterMessageId: session.revert?.branchCutAfterMessageID,
    rewindCreatedMessageId: session.revert?.createdMessageID,
    rewindKeptMessageIds: session.revert?.keptMessageIDs,
    rewindTargetMessageId: session.revert?.targetMessageID,
  });
}
function sourceCurrent(store: SqliteStoreAccess, capsule: ContextCapsule): boolean {
  const source = sessions.getSession(store.db, capsule.sourceSessionId as SessionId);
  const target = sessions.getSession(store.db, capsule.targetSessionId as SessionId);
  if (
    !source ||
    !target ||
    !scopeMatches(source, capsule.sourceScope) ||
    !scopeMatches(target, capsule.targetScope) ||
    !sameScope(source, target)
  )
    return false;
  const active = activeMessages(messages.messagesSync(store.db, { sessionID: source.id }), source);
  const prefix = stableContextMessages(active).slice(0, capsule.sourceMessageIds.length);
  if (
    prefix.length !== capsule.sourceMessageIds.length ||
    prefix.some((message, index) => message.info.id !== capsule.sourceMessageIds[index])
  )
    return false;
  return (
    digest(contextCapsuleSourcePayload(source, prefix)) === capsule.sourceVersion &&
    digest(capsule.content) === capsule.contentSha256
  );
}
function readStored(
  store: SqliteStoreAccess,
  sessionId: SessionId,
  capsuleId: string,
): ContextCapsule | undefined {
  const entry = entries
    .sessionEntries(store.db, { sessionID: sessionId, type: CONTEXT_CAPSULE_ENTRY_TYPE })
    .find((record) => record.id === `${sessionId}:context-capsule:${capsuleId}`);
  const parsed = ContextCapsuleSchema.safeParse(entry?.data);
  return parsed.success && parsed.data.targetSessionId === sessionId ? parsed.data : undefined;
}

export const contextCapsuleMethods = {
  async readContextCapsule(
    this: SqliteStoreAccess,
    input: { sessionId: SessionId; capsuleId: string },
  ): Promise<ContextCapsule | undefined> {
    return readStored(this, input.sessionId, input.capsuleId);
  },
  async commitContextCapsule(
    this: SqliteStoreAccess,
    candidate: ContextCapsule,
    options?: { signal?: AbortSignal },
  ): Promise<ContextCapsuleCommitResult> {
    this.throwBeforeWrite();
    if (options?.signal?.aborted) return { status: "stale" };
    const capsule = ContextCapsuleSchema.parse(candidate);
    const expectedId = `capsule_${digest(`${capsule.targetSessionId}\n${capsule.operationId}`).slice(0, 32)}`;
    if (capsule.id !== expectedId || digest(capsule.content) !== capsule.contentSha256)
      throw new Error("Context capsule identity or content hash is invalid.");
    this.db.exec("begin immediate");
    try {
      const target = sessions.getSession(this.db, capsule.targetSessionId as SessionId);
      if (!target || !sourceCurrent(this, capsule)) {
        this.db.exec("rollback");
        return { status: "stale" };
      }
      const active = activeMessages(
        messages.messagesSync(this.db, { sessionID: target.id }),
        target,
      );
      if (options?.signal?.aborted) {
        this.db.exec("rollback");
        return { status: "stale" };
      }
      const targetMessage = active.findLast(
        (message) => message.info.role === "user" && message.info.anchor?.origin === "realUser",
      );
      if (
        targetMessage?.info.role !== "user" ||
        targetMessage.info.id !== capsule.targetMessageId ||
        targetMessage.info.anchor?.turnId !== capsule.targetTurnId
      ) {
        this.db.exec("rollback");
        return { status: "stale" };
      }
      const existing = readStored(this, target.id, capsule.id);
      if (existing) {
        if (
          existing.sourceVersion !== capsule.sourceVersion ||
          existing.contentSha256 !== capsule.contentSha256 ||
          existing.targetMessageId !== capsule.targetMessageId ||
          existing.targetTurnId !== capsule.targetTurnId
        )
          throw new Error("Context capsule operation already owns a different result.");
        this.db.exec("commit");
        return { status: "reused", capsule: existing };
      }
      if (
        entries.sessionEntries(this.db, { sessionID: target.id, type: CONTEXT_CAPSULE_ENTRY_TYPE })
          .length >= CONTEXT_CAPSULE_MAX_PER_SESSION
      ) {
        this.db.exec("rollback");
        return { status: "unavailable" };
      }
      entries.saveSessionEntry(this.db, {
        id: `${target.id}:context-capsule:${capsule.id}`,
        sessionID: target.id,
        type: CONTEXT_CAPSULE_ENTRY_TYPE,
        touchSession: false,
        time: { created: capsule.createdAtMs, updated: capsule.createdAtMs },
        data: capsule,
      });
      const prior = Array.isArray(targetMessage.info.metadata?.contextCapsuleIds)
        ? targetMessage.info.metadata.contextCapsuleIds.filter(
            (id): id is string => typeof id === "string",
          )
        : [];
      messages.saveMessageSync(this.db, {
        ...targetMessage.info,
        metadata: {
          ...targetMessage.info.metadata,
          contextCapsuleIds: [...new Set([...prior, capsule.id])],
        },
      });
      if (options?.signal?.aborted) {
        this.db.exec("rollback");
        return { status: "stale" };
      }
      this.db.exec("commit");
      return { status: "committed", capsule };
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  },
  async attachContextCapsulesToInput(
    this: SqliteStoreAccess,
    input: ContextCapsuleAttachInput,
    options?: { signal?: AbortSignal },
  ): Promise<boolean> {
    this.throwBeforeWrite();
    if (options?.signal?.aborted) return false;
    if (
      !input.capsuleIds.length ||
      input.capsuleIds.length > 4 ||
      new Set(input.capsuleIds).size !== input.capsuleIds.length
    )
      return false;
    this.db.exec("begin immediate");
    try {
      const target = sessions.getSession(this.db, input.sessionId as SessionId);
      const accepted = inputs.getSessionInputByIdSync(this.db, input.inputId);
      if (
        !target ||
        !scopeMatches(target, input.expectedScope) ||
        !accepted ||
        accepted.sessionID !== target.id ||
        accepted.status !== "promoted" ||
        accepted.promotedMessageID !== input.targetMessageId
      ) {
        this.db.exec("rollback");
        return false;
      }
      const currentUser = activeMessages(
        messages.messagesSync(this.db, { sessionID: target.id }),
        target,
      ).findLast(
        (message) => message.info.role === "user" && message.info.anchor?.origin === "realUser",
      );
      if (
        currentUser?.info.id !== input.targetMessageId ||
        currentUser.info.anchor?.turnId !== input.targetTurnId
      ) {
        this.db.exec("rollback");
        return false;
      }
      const intent = accepted.payload.intent as
        | { contextCapsuleRefs?: Array<{ capsule_id: string }> }
        | undefined;
      if (
        intent?.contextCapsuleRefs?.length !== input.capsuleIds.length ||
        input.capsuleIds.some((id, index) => intent.contextCapsuleRefs![index]?.capsule_id !== id)
      ) {
        this.db.exec("rollback");
        return false;
      }
      for (const id of input.capsuleIds) {
        const capsule = readStored(this, target.id, id);
        if (!capsule || !sourceCurrent(this, capsule)) {
          this.db.exec("rollback");
          return false;
        }
      }
      const associationId = `${target.id}:context-capsule-input:${input.inputId}`;
      if (options?.signal?.aborted) {
        this.db.exec("rollback");
        return false;
      }
      const prior = entries
        .sessionEntries(this.db, { sessionID: target.id, type: "runtime/context_capsule_input" })
        .find((entry) => entry.id === associationId);
      const association = {
        inputId: input.inputId,
        targetMessageId: input.targetMessageId,
        targetTurnId: input.targetTurnId,
        capsuleIds: input.capsuleIds,
      };
      if (prior) {
        if (JSON.stringify(prior.data) !== JSON.stringify(association)) {
          this.db.exec("rollback");
          return false;
        }
      } else {
        entries.saveSessionEntry(this.db, {
          id: associationId,
          sessionID: target.id,
          type: "runtime/context_capsule_input",
          touchSession: false,
          time: { created: Date.now(), updated: Date.now() },
          data: association,
        });
      }
      this.db.exec("commit");
      return true;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  },
};
