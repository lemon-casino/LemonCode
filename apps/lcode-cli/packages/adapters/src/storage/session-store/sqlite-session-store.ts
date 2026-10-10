import * as permissionFullAccessRepository from "./repositories/permission-full-access.js";
import { beginGoalEvidenceExecution, saveImmutableGoalEvidenceReceipt } from "./store-goal-evidence.js";
import { SESSION_ENTRY_GOAL_EVIDENCE, SESSION_ENTRY_GOAL_EVIDENCE_HEAD, SESSION_ENTRY_GOAL_EVIDENCE_ATTEMPT } from "@lcode/contracts";
import { DatabaseSync } from "node:sqlite";
import type {
  ClaimLegacySessionWorkspaceInput,
  RepairLegacyRemoteSessionWorkspaceInput,
  RepairRemoteSessionPathsInput,
  CreateSessionInput,
  FileDiff,
  InputHistoryStorePort,
  ListSessionsInput,
  LocalSettingStorePort,
  MessageId,
  MessageInfo,
  MessagePart,
  MessageWithParts,
  PartId,
  SessionEntryInfo,
  SessionEntryType,
  ScriptWorkflowStorePort,
  SessionId,
  SessionInfo,
  SessionInputDelivery,
  SessionInputRecord,
  SessionInputStatus,
  SessionRevert,
  ReadSessionTranscriptSnapshotInput,
  ReadSessionTranscriptWindowInput,
  SessionTranscriptSnapshot,
  SessionTranscriptWindow,
  SessionStorePort,
  UpdateSessionInput,
  UsageStorePort,
} from "@lcode/contracts";
// 端口留在领域包 @lcode/dynamic-workflow，这里只做类型引用：adapters 运行时不依赖它。
import type { JournalStorePort } from "@lcode/dynamic-workflow";
import { SqliteSessionMigrationError } from "./errors.js";
import {
  DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS,
  runSqliteSessionMigrations,
  runSqliteSessionMigrationsAsync,
  type AsyncSqliteMigrationOptions,
} from "./migration-runner.js";
import type {
  ForkCommitFaultStage,
  SessionStoreDebugCounts,
  SqliteSessionStoreOptions,
} from "./options.js";
import { ensureParentDir, getDefaultSessionDbPath } from "./paths.js";
import { maybeThrowStorageFsFault } from "../fs-fault-injection.js";
import * as debugRepository from "./repositories/debug.js";
import { createDwfJournalStore } from "./repositories/dwf-journal.js";
import * as messageRepository from "./repositories/messages.js";
import * as sessionEntryRepository from "./repositories/session-entries.js";
import * as sessionInputRepository from "./repositories/session-inputs.js";
import * as sessionRepository from "./repositories/sessions.js";
import * as transcriptSnapshotRepository from "./repositories/transcript-snapshot.js";
import { readTranscriptWindow } from "./repositories/transcript-window.js";

import { sessionForkMethods } from "./store-fork.js";
import { sharedContextMethods } from "./store-shared-context.js";
import { contextCapsuleMethods } from "./store-context-capsule.js";
import { sessionTargetMethods } from "./store-target.js";
import { auxiliaryStoreMethods } from "./store-auxiliary.js";
import { worktreeCleanupMethods } from "./store-worktree-cleanup.js";
import { worktreeRebindMethods } from "./store-worktree-rebind.js";
import type { StoreMethods } from "./store-access.js";

type ForkMethods = StoreMethods<typeof sessionForkMethods>;
type SharedContextMethods = StoreMethods<typeof sharedContextMethods>;
type TargetMethods = StoreMethods<typeof sessionTargetMethods>;
type AuxiliaryMethods = StoreMethods<typeof auxiliaryStoreMethods>;

const deferredStartup = Symbol("deferredSqliteStartup");

export class SqliteSessionStore
  implements
    SessionStorePort,
    InputHistoryStorePort,
    LocalSettingStorePort,
    ScriptWorkflowStorePort,
    UsageStorePort
{
  // 方法由下方 descriptor 安装，declare 不生成实例字段；连接/缓存仍由本类独占。
  declare createForkedSessionWithMetadata: ForkMethods["createForkedSessionWithMetadata"];
  declare commitForkBundle: ForkMethods["commitForkBundle"];
  declare commitSharedContextImportBundle: SharedContextMethods["commitSharedContextImportBundle"];
  declare transitionSharedContextImport: SharedContextMethods["transitionSharedContextImport"];
  declare commitContextCapsule: StoreMethods<typeof contextCapsuleMethods>["commitContextCapsule"];
  declare readContextCapsule: StoreMethods<typeof contextCapsuleMethods>["readContextCapsule"];
  declare attachContextCapsulesToInput: StoreMethods<
    typeof contextCapsuleMethods
  >["attachContextCapsulesToInput"];
  declare readTodos: TargetMethods["readTodos"];
  declare updateTodos: TargetMethods["updateTodos"];
  declare readTarget: TargetMethods["readTarget"];
  declare setTarget: TargetMethods["setTarget"];
  declare cloneTargetForFork: TargetMethods["cloneTargetForFork"];
  declare createTarget: TargetMethods["createTarget"];
  declare updateTargetStatus: TargetMethods["updateTargetStatus"];
  declare startTargetRun: TargetMethods["startTargetRun"];
  declare heartbeatTargetRun: TargetMethods["heartbeatTargetRun"];
  declare finishTargetRun: TargetMethods["finishTargetRun"];
  declare recoverInterruptedTargetRun: TargetMethods["recoverInterruptedTargetRun"];
  declare accountTargetUsage: TargetMethods["accountTargetUsage"];
  declare updateTargetSummaryTitle: TargetMethods["updateTargetSummaryTitle"];
  declare clearTarget: TargetMethods["clearTarget"];
  declare recordModelUsage: AuxiliaryMethods["recordModelUsage"];
  declare upsertTurnUsage: AuxiliaryMethods["upsertTurnUsage"];
  declare upsertToolUsage: AuxiliaryMethods["upsertToolUsage"];
  declare pruneUsage: AuxiliaryMethods["pruneUsage"];
  declare queryAppUsage: AuxiliaryMethods["queryAppUsage"];
  declare queryTaskUsage: AuxiliaryMethods["queryTaskUsage"];
  declare recordInputHistory: AuxiliaryMethods["recordInputHistory"];
  declare recallPreviousInputHistory: AuxiliaryMethods["recallPreviousInputHistory"];
  declare getProjectPermission: AuxiliaryMethods["getProjectPermission"];
  declare saveProjectPermission: AuxiliaryMethods["saveProjectPermission"];
  declare getProjectPermissionMode: AuxiliaryMethods["getProjectPermissionMode"];
  declare saveProjectPermissionMode: AuxiliaryMethods["saveProjectPermissionMode"];
  declare upsertScriptWorkflowDefinition: AuxiliaryMethods["upsertScriptWorkflowDefinition"];
  declare createScriptWorkflowRun: AuxiliaryMethods["createScriptWorkflowRun"];
  declare updateScriptWorkflowRun: AuxiliaryMethods["updateScriptWorkflowRun"];
  declare getScriptWorkflowRun: AuxiliaryMethods["getScriptWorkflowRun"];
  declare listScriptWorkflowRuns: AuxiliaryMethods["listScriptWorkflowRuns"];
  declare createScriptWorkflowActivity: AuxiliaryMethods["createScriptWorkflowActivity"];
  declare updateScriptWorkflowActivity: AuxiliaryMethods["updateScriptWorkflowActivity"];
  declare findCachedScriptWorkflowActivity: AuxiliaryMethods["findCachedScriptWorkflowActivity"];
  declare listScriptWorkflowActivities: AuxiliaryMethods["listScriptWorkflowActivities"];
  declare appendScriptWorkflowEvent: AuxiliaryMethods["appendScriptWorkflowEvent"];
  declare listScriptWorkflowEvents: AuxiliaryMethods["listScriptWorkflowEvents"];
  declare createSessionTaskLink: AuxiliaryMethods["createSessionTaskLink"];
  declare worktreeCleanup: StoreMethods<typeof worktreeCleanupMethods>["worktreeCleanup"];
  declare worktreeRebind: StoreMethods<typeof worktreeRebindMethods>["worktreeRebind"];

  private readonly db: DatabaseSync;
  private readonly dbPath: string;
  private readonly forkCommitFaultAt?: ForkCommitFaultStage;
  private dwfJournalStore?: JournalStorePort;

  constructor(options: SqliteSessionStoreOptions = {}, startupToken?: symbol) {
    this.dbPath = options.dbPath ?? getDefaultSessionDbPath();
    this.forkCommitFaultAt = options.forkCommitFaultAt;
    const startupLockTimeoutMs =
      options.startupLockTimeoutMs ?? DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS;
    try {
      ensureParentDir(this.dbPath);
      maybeThrowStorageFsFault({ operation: "sqliteOpen", path: this.dbPath });
      // 多个本地或远程 Agent 会共享同一个 session DB；timeout 必须在执行首条
      // PRAGMA 前生效，否则并发启动会在 migration prelude 直接抛 database is locked。
      this.db = new DatabaseSync(this.dbPath, { timeout: startupLockTimeoutMs });
    } catch (error) {
      throw new SqliteSessionMigrationError(
        `Failed to open SQLite session database at ${this.dbPath}`,
        {
          cause: error,
          dbPath: this.dbPath,
          kind: "open_failed",
        },
      );
    }
    try {
      if (startupToken !== deferredStartup)
        runSqliteSessionMigrations(this.db, this.dbPath, startupLockTimeoutMs);
    } catch (error) {
      try {
        this.db.close();
      } catch {
        /* 保留原始迁移失败。 */
      }
      throw error;
    }
  }

  static async openStartup(
    options: SqliteSessionStoreOptions = {},
    migrationOptions: AsyncSqliteMigrationOptions = {},
  ): Promise<SqliteSessionStore> {
    // 未迁移的实例只保留在这个工厂内部；所有 Repo/业务只可能拿到 COMMIT 后的连接。
    const store = new SqliteSessionStore(options, deferredStartup);
    try {
      await runSqliteSessionMigrationsAsync(store.db, store.dbPath, migrationOptions);
      return store;
    } catch (error) {
      // close 也可能因 IO 失败；迁移的原始 cause 才是用户应处理的原因。
      try {
        store.close();
      } catch {
        /* 保留原始迁移失败。 */
      }
      throw error;
    }
  }

  getDatabasePath(): string {
    return this.dbPath;
  }

  close(): void {
    this.db.close();
  }

  private throwBeforeWrite(): void {
    maybeThrowStorageFsFault({ operation: "sqliteRun", path: this.dbPath });
  }

  private maybeThrowForkCommitFault(stage: ForkCommitFaultStage): void {
    if (this.forkCommitFaultAt === stage) {
      throw new Error(`injected fork commit fault: ${stage}`);
    }
  }

  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    this.throwBeforeWrite();
    if (!input.initialEntries?.length) return sessionRepository.createSession(this.db, input);
    this.db.exec("begin immediate");
    try {
      const session = sessionRepository.createSession(this.db, input);
      for (const entry of input.initialEntries) {
        if (entry.sessionID !== input.id)
          throw new Error("Initial entry must belong to the created session");
        sessionEntryRepository.saveSessionEntry(this.db, entry);
      }
      this.db.exec("commit");
      return session;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  async updateSession(input: UpdateSessionInput): Promise<SessionInfo> {
    this.throwBeforeWrite();
    return sessionRepository.updateSession(this.db, input);
  }

  async getSession(sessionID: SessionId): Promise<SessionInfo | null> {
    return sessionRepository.getSession(this.db, sessionID);
  }

  async listSessions(input: ListSessionsInput = {}): Promise<SessionInfo[]> {
    return sessionRepository.listSessions(this.db, input);
  }

  async claimLegacySessionWorkspace(input: ClaimLegacySessionWorkspaceInput): Promise<number> {
    this.throwBeforeWrite();
    return sessionRepository.claimLegacySessionWorkspace(this.db, input);
  }

  async repairLegacyRemoteSessionWorkspace(
    input: RepairLegacyRemoteSessionWorkspaceInput,
  ): Promise<boolean> {
    this.throwBeforeWrite();
    return sessionRepository.repairLegacyRemoteSessionWorkspace(this.db, input);
  }

  async repairRemoteSessionPaths(input: RepairRemoteSessionPathsInput): Promise<boolean> {
    this.throwBeforeWrite();
    return sessionRepository.repairRemoteSessionPaths(this.db, input);
  }

  async saveMessage(
    input: MessageInfo,
    copyFrom?: Parameters<SessionStorePort["saveMessage"]>[1],
  ): Promise<void> {
    this.throwBeforeWrite();
    return messageRepository.saveMessage(this.db, input, copyFrom);
  }

  async removeMessage(input: { sessionID: SessionId; messageID: MessageId }): Promise<void> {
    this.throwBeforeWrite();
    return messageRepository.removeMessage(this.db, input);
  }

  async savePart(
    input: MessagePart,
    copyFrom?: Parameters<SessionStorePort["savePart"]>[1],
  ): Promise<void> {
    this.throwBeforeWrite();
    return messageRepository.savePart(this.db, input, copyFrom);
  }

  async removePart(input: {
    sessionID: SessionId;
    messageID: MessageId;
    partID: PartId;
  }): Promise<void> {
    this.throwBeforeWrite();
    return messageRepository.removePart(this.db, input);
  }

  async messageWithParts(input: {
    sessionID: SessionId;
    messageID: MessageId;
  }): Promise<MessageWithParts | null> {
    return messageRepository.messageWithParts(this.db, input);
  }

  async messages(input: { sessionID: SessionId }): Promise<MessageWithParts[]> {
    return messageRepository.messages(this.db, input);
  }

  async readTranscriptSnapshot(
    input: ReadSessionTranscriptSnapshotInput,
  ): Promise<SessionTranscriptSnapshot> {
    return transcriptSnapshotRepository.readTranscriptSnapshot(this.db, input);
  }

  async readTranscriptWindow(
    input: ReadSessionTranscriptWindowInput,
  ): Promise<SessionTranscriptWindow> {
    return readTranscriptWindow(this.db, input);
  }

  async saveSessionEntry(input: SessionEntryInfo): Promise<void> {
    this.throwBeforeWrite();
    if (input.type === SESSION_ENTRY_GOAL_EVIDENCE_HEAD || input.type === SESSION_ENTRY_GOAL_EVIDENCE_ATTEMPT) throw new Error("Goal evidence heads and attempts require atomic admission");
    if (input.type === SESSION_ENTRY_GOAL_EVIDENCE) return saveImmutableGoalEvidenceReceipt(this.db, input);
    return sessionEntryRepository.saveSessionEntry(this.db, input);
  }

  async beginGoalEvidenceExecution(input: Parameters<NonNullable<SessionStorePort["beginGoalEvidenceExecution"]>>[0]) {
    this.throwBeforeWrite();
    return beginGoalEvidenceExecution(this.db, input);
  }

  async sessionEntries(input: {
    sessionID: SessionId;
    type?: SessionEntryType | string;
    limit?: number;
  }): Promise<SessionEntryInfo[]> {
    return sessionEntryRepository.sessionEntries(this.db, input);
  }

  // ── session_input 账本──

  async saveSessionInput(input: {
    id: string;
    sessionID: SessionId;
    kind: string;
    delivery: SessionInputDelivery;
    payload: { text: string; [key: string]: unknown };
  }): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.saveSessionInput(this.db, input);
  }

  async commitPermissionFullAccess(
    input: Parameters<NonNullable<SessionStorePort["commitPermissionFullAccess"]>>[0],
  ): Promise<void> {
    this.throwBeforeWrite();
    return permissionFullAccessRepository.commitPermissionFullAccess(this.db, input);
  }

  async updateSessionInputs(
    input: Parameters<NonNullable<SessionStorePort["updateSessionInputs"]>>[0],
  ): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.updateSessionInputs(this.db, input);
  }

  async promoteSessionInput(input: {
    id: string;
    sessionID: SessionId;
    message: MessageInfo;
    parts: MessagePart[];
  }): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.promoteSessionInput(this.db, input);
  }

  async markSessionInputPromoted(input: {
    id: string;
    sessionID: SessionId;
    promotedMessageID: MessageId;
  }): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.markSessionInputPromoted(this.db, input);
  }

  async settleSessionInput(input: {
    id: string;
    sessionID: SessionId;
    status: "cancelled" | "discarded" | "failed";
    reason?: string;
  }): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.settleSessionInput(this.db, input);
  }

  async listSessionInputs(input: {
    sessionID: SessionId;
    status?: SessionInputStatus;
  }): Promise<SessionInputRecord[]> {
    return sessionInputRepository.listSessionInputs(this.db, input);
  }

  async getSessionInputById(id: string): Promise<SessionInputRecord | null> {
    return sessionInputRepository.getSessionInputById(this.db, id);
  }

  async setRevert(input: {
    sessionID: SessionId;
    revert: SessionRevert;
    summary?: { additions: number; deletions: number; files: number; diffs?: FileDiff[] };
  }): Promise<void> {
    return sessionRepository.setRevert(this.db, input);
  }

  async clearRevert(sessionID: SessionId): Promise<void> {
    return sessionRepository.clearRevert(this.db, sessionID);
  }

  /**
   * dynamic-workflow 执行引擎的 durable journal（dwf_* 表）。端口是同步的，所以这里返回
   * 端口对象本身而不是逐方法转发——引擎持有它、按自己的节奏读写。
   */
  workflowJournalStore(): JournalStorePort {
    this.dwfJournalStore ??= createDwfJournalStore(this.db);
    return this.dwfJournalStore;
  }

  debugMigrationIds(): string[] {
    return debugRepository.debugMigrationIds(this.db);
  }

  debugCounts(sessionID?: SessionId): SessionStoreDebugCounts {
    return debugRepository.debugCounts(this.db, sessionID);
  }
}

// 保持既有 class prototype 方法描述符和调用 arity；拆出的职责借用同一实例，不复制连接/缓存。
for (const methods of [
  sessionForkMethods,
  sharedContextMethods,
  contextCapsuleMethods,
  sessionTargetMethods,
  auxiliaryStoreMethods,
  worktreeCleanupMethods,
  worktreeRebindMethods,
]) {
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(methods))) {
    Object.defineProperty(SqliteSessionStore.prototype, name, { ...descriptor, enumerable: false });
  }
}

export function createSqliteSessionStore(
  options: SqliteSessionStoreOptions = {},
): SqliteSessionStore {
  return new SqliteSessionStore(options);
}

export function openStartupSqliteSessionStore(
  options: SqliteSessionStoreOptions = {},
): SqliteSessionStore {
  return new SqliteSessionStore(options);
}

export { getDefaultSessionDbPath };
