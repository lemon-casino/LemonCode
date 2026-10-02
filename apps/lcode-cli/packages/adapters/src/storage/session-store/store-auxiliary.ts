import type {
  CollaborationMode,
  CreateScriptWorkflowActivityInput,
  CreateScriptWorkflowRunInput,
  CreateSessionTaskLinkInput,
  InputHistoryAttachment,
  InputHistoryEntry,
  InputHistoryKind,
  AppUsageQueryInput,
  AppUsageQueryResult,
  ModelUsageRecord,
  PermissionRuleset,
  ProjectId,
  ScriptWorkflowActivityRecord,
  ScriptWorkflowDefinitionRecord,
  ScriptWorkflowEventRecord,
  ScriptWorkflowRunRecord,
  ScriptWorkflowRunStatus,
  SessionId,
  SessionTaskLinkRecord,
  TaskUsageQueryInput,
  TaskUsageQueryResult,
  ToolUsageRecord,
  TurnUsageRecord,
  UpsertScriptWorkflowDefinitionInput,
  UpdateScriptWorkflowActivityInput,
  UpdateScriptWorkflowRunInput,
} from "@lcode/contracts";
import type { SqliteStoreAccess } from "./store-access.js";
import * as usageRepository from "./repositories/usage.js";
import * as inputHistoryRepository from "./repositories/input-history.js";
import * as localSettingsRepository from "./repositories/local-settings.js";
import * as scriptWorkflowActivityRepository from "./repositories/script-workflow-activities.js";
import * as scriptWorkflowRunRepository from "./repositories/script-workflow-runs.js";

export const auxiliaryStoreMethods = {
  async recordModelUsage(this: SqliteStoreAccess, input: ModelUsageRecord): Promise<void> {
    return usageRepository.recordModelUsage(this.db, input);
  },

  async upsertTurnUsage(this: SqliteStoreAccess, input: TurnUsageRecord): Promise<void> {
    return usageRepository.upsertTurnUsage(this.db, input);
  },

  async upsertToolUsage(this: SqliteStoreAccess, input: ToolUsageRecord): Promise<void> {
    return usageRepository.upsertToolUsage(this.db, input);
  },

  async pruneUsage(this: SqliteStoreAccess, input?: { beforeTime?: number }): Promise<void> {
    return usageRepository.pruneUsage(this.db, input);
  },

  async queryAppUsage(
    this: SqliteStoreAccess,
    input: AppUsageQueryInput,
  ): Promise<AppUsageQueryResult> {
    return usageRepository.queryAppUsage(this.db, input);
  },

  async queryTaskUsage(
    this: SqliteStoreAccess,
    input: TaskUsageQueryInput,
  ): Promise<TaskUsageQueryResult> {
    return usageRepository.queryTaskUsage(this.db, input);
  },

  async recordInputHistory(
    this: SqliteStoreAccess,
    input: {
      projectID: ProjectId;
      sessionID?: SessionId;
      text: string;
      attachments?: InputHistoryAttachment[];
      kind: InputHistoryKind;
      time?: { created?: number };
    },
  ): Promise<InputHistoryEntry | null> {
    return inputHistoryRepository.recordInputHistory(this.db, input);
  },

  async recallPreviousInputHistory(
    this: SqliteStoreAccess,
    input: {
      projectID: ProjectId;
      skip?: number;
    },
  ): Promise<InputHistoryEntry | null> {
    return inputHistoryRepository.recallPreviousInputHistory(this.db, input);
  },

  async getProjectPermission(
    this: SqliteStoreAccess,
    projectID: ProjectId,
  ): Promise<PermissionRuleset | null> {
    return localSettingsRepository.getProjectPermission(this.db, projectID);
  },

  async saveProjectPermission(
    this: SqliteStoreAccess,
    input: {
      projectID: ProjectId;
      permission: PermissionRuleset;
    },
  ): Promise<PermissionRuleset> {
    return localSettingsRepository.saveProjectPermission(this.db, input);
  },

  getProjectPermissionMode(
    this: SqliteStoreAccess,
    projectID: ProjectId,
  ): CollaborationMode | null {
    return localSettingsRepository.getProjectPermissionMode(this.db, projectID);
  },

  saveProjectPermissionMode(
    this: SqliteStoreAccess,
    input: {
      mode: CollaborationMode;
      projectID: ProjectId;
    },
  ): CollaborationMode {
    return localSettingsRepository.saveProjectPermissionMode(this.db, input);
  },

  async upsertScriptWorkflowDefinition(
    this: SqliteStoreAccess,
    input: UpsertScriptWorkflowDefinitionInput,
  ): Promise<ScriptWorkflowDefinitionRecord> {
    return scriptWorkflowRunRepository.upsertScriptWorkflowDefinition(this.db, input);
  },

  async createScriptWorkflowRun(
    this: SqliteStoreAccess,
    input: CreateScriptWorkflowRunInput,
  ): Promise<ScriptWorkflowRunRecord> {
    return scriptWorkflowRunRepository.createScriptWorkflowRun(this.db, input);
  },

  async updateScriptWorkflowRun(
    this: SqliteStoreAccess,
    input: UpdateScriptWorkflowRunInput,
  ): Promise<ScriptWorkflowRunRecord> {
    return scriptWorkflowRunRepository.updateScriptWorkflowRun(this.db, input);
  },

  async getScriptWorkflowRun(
    this: SqliteStoreAccess,
    runId: string,
  ): Promise<ScriptWorkflowRunRecord | null> {
    return scriptWorkflowRunRepository.getScriptWorkflowRun(this.db, runId);
  },

  async listScriptWorkflowRuns(
    this: SqliteStoreAccess,
    input?: {
      cwd?: string;
      limit?: number;
      statuses?: readonly ScriptWorkflowRunStatus[];
    },
  ): Promise<ScriptWorkflowRunRecord[]> {
    return scriptWorkflowRunRepository.listScriptWorkflowRuns(this.db, input);
  },

  async createScriptWorkflowActivity(
    this: SqliteStoreAccess,
    input: CreateScriptWorkflowActivityInput,
  ): Promise<ScriptWorkflowActivityRecord> {
    return scriptWorkflowActivityRepository.createScriptWorkflowActivity(this.db, input);
  },

  async updateScriptWorkflowActivity(
    this: SqliteStoreAccess,
    input: UpdateScriptWorkflowActivityInput,
  ): Promise<ScriptWorkflowActivityRecord> {
    return scriptWorkflowActivityRepository.updateScriptWorkflowActivity(this.db, input);
  },

  async findCachedScriptWorkflowActivity(
    this: SqliteStoreAccess,
    input: {
      callPath: string;
      inputHash: string;
      runId: string;
    },
  ): Promise<ScriptWorkflowActivityRecord | null> {
    return scriptWorkflowActivityRepository.findCachedScriptWorkflowActivity(this.db, input);
  },

  async listScriptWorkflowActivities(
    this: SqliteStoreAccess,
    input: {
      runId: string;
    },
  ): Promise<ScriptWorkflowActivityRecord[]> {
    return scriptWorkflowActivityRepository.listScriptWorkflowActivities(this.db, input);
  },

  async appendScriptWorkflowEvent(
    this: SqliteStoreAccess,
    input: {
      activityId?: string;
      id: string;
      payload?: unknown;
      phase?: string;
      runId: string;
      type: string;
    },
  ): Promise<ScriptWorkflowEventRecord> {
    return scriptWorkflowActivityRepository.appendScriptWorkflowEvent(this.db, input);
  },

  async listScriptWorkflowEvents(
    this: SqliteStoreAccess,
    input: {
      limit?: number;
      runId: string;
    },
  ): Promise<ScriptWorkflowEventRecord[]> {
    return scriptWorkflowActivityRepository.listScriptWorkflowEvents(this.db, input);
  },

  async createSessionTaskLink(
    this: SqliteStoreAccess,
    input: CreateSessionTaskLinkInput,
  ): Promise<SessionTaskLinkRecord> {
    return scriptWorkflowActivityRepository.createSessionTaskLink(this.db, input);
  },
};
