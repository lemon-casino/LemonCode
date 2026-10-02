import type {
  SessionInfo,
  SharedContextImportCommitBundle,
  SharedContextImportTransition,
} from "@lcode/contracts";
import type { SqliteStoreAccess } from "./store-access.js";
import * as sessionRepository from "./repositories/sessions.js";
import * as sessionEntryRepository from "./repositories/session-entries.js";
import * as messageRepository from "./repositories/messages.js";

export const sharedContextMethods = {
  async commitSharedContextImportBundle(
    this: SqliteStoreAccess,
    bundle: SharedContextImportCommitBundle,
  ): Promise<SessionInfo> {
    this.throwBeforeWrite();
    const { session, contextMessage, provenance } = bundle;
    if (
      String(contextMessage.info.sessionID) !== String(session.id) ||
      String(provenance.sessionID) !== String(session.id) ||
      // session_entry.id 是全库主键，saveSessionEntry 的 on conflict(id)
      // 会把 session_id 改绑到后写入者。provenance id 若不含 session 命名空间，同一个
      // share 导入到第二个会话时会夺走第一个会话的条目（旧会话 transcript 静默丢失）。
      // 这里在唯一写入口做守卫，覆盖所有调用方，而不是只修某一个构造点。
      !provenance.id.includes(String(session.id)) ||
      contextMessage.info.role !== "user" ||
      contextMessage.info.visibility !== "model-only" ||
      contextMessage.info.source !== "shared_context"
    ) {
      throw new Error("Shared context import bundle identity is invalid");
    }
    this.db.exec("begin immediate");
    try {
      const existing = sessionRepository.getSession(this.db, session.id);
      if (existing) {
        const entry = sessionEntryRepository
          .sessionEntries(this.db, { sessionID: session.id, type: provenance.type })
          .find((candidate) => candidate.id === provenance.id);
        if (!entry) throw new Error("Shared context import session is incomplete");
        this.db.exec("commit");
        return existing;
      }
      const persisted = sessionRepository.createSession(this.db, session);
      await messageRepository.saveMessage(this.db, contextMessage.info);
      for (const part of contextMessage.parts) {
        await messageRepository.savePart(this.db, part);
      }
      sessionEntryRepository.saveSessionEntry(this.db, provenance);
      this.db.exec("commit");
      return persisted;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  },

  async transitionSharedContextImport(
    this: SqliteStoreAccess,
    input: SharedContextImportTransition,
  ): Promise<boolean> {
    this.throwBeforeWrite();
    this.db.exec("begin immediate");
    try {
      const entry = sessionEntryRepository
        .sessionEntries(this.db, { sessionID: input.sessionID, type: "v4/shared_context_import" })
        .find((candidate) => {
          const data = candidate.data;
          return Boolean(
            data &&
            typeof data === "object" &&
            !Array.isArray(data) &&
            (data as Record<string, unknown>).contextId === input.contextId,
          );
        });
      if (!entry) {
        this.db.exec("rollback");
        return false;
      }
      const data = entry.data as Record<string, unknown>;
      const expected = Array.isArray(input.expectedStatus)
        ? input.expectedStatus
        : [input.expectedStatus];
      if (!expected.includes(data.status as SharedContextImportTransition["status"])) {
        this.db.exec("rollback");
        return false;
      }
      sessionEntryRepository.saveSessionEntry(this.db, {
        ...entry,
        time: { ...entry.time, updated: Date.now() },
        data: {
          ...data,
          status: input.status,
          ...(input.sourceId ? { sourceId: input.sourceId } : {}),
        },
      });
      const contextMessage = (
        await messageRepository.messages(this.db, { sessionID: input.sessionID })
      ).find((message) => {
        const metadata = message.info.metadata;
        return Boolean(
          metadata &&
          typeof metadata === "object" &&
          (metadata as Record<string, unknown>).contextId === input.contextId,
        );
      });
      if (contextMessage) {
        await messageRepository.saveMessage(this.db, {
          ...contextMessage.info,
          metadata: {
            ...contextMessage.info.metadata,
            sharedContextStatus: input.status,
          },
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
