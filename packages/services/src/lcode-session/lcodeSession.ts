import { ServiceChannels } from "@lcode/shared";
import type {
  TraceId,
  LCodeAgentMcpServer,
  LCodeDeliveryKind,
  LCodeMessageWithParts,
  ModelSelection,
  LCodePermissionRequestParams,
  LCodeUserInputRequestParams,
  LCodeUserInputResponse,
  LCodeSessionInfo,
  LCodeSessionImportHistory,
  LCodeSessionEvent,
  LCodeSessionMode,
  LCodeSessionPersistence,
  LCodeSessionStateSnapshot,
  LCodeStateUpdatedNotification,
  LCodeWorkspacePresentation,
} from "@lcode/shared";
import { createServiceDescriptor } from "#src/descriptors.js";

export interface LCodeSessionWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export type LCodeSessionReadWorkspacePresentationParams = LCodeSessionWorkspaceTarget;

export interface LCodeTaskTarget extends LCodeSessionWorkspaceTarget {
  sessionId: string;
}

export interface LCodeSessionCreateParams extends LCodeSessionWorkspaceTarget {
  /** 仅导入事务使用的预分配 ID；普通新会话继续由 Agent 分配。 */
  sessionId?: string;
  sessionTraceId?: TraceId;
  parentSessionId?: string;
  mode?: LCodeSessionMode;
  model?: ModelSelection;
  persistence?: LCodeSessionPersistence;
  thoughtLevel?: string;
  mcpServers?: LCodeAgentMcpServer[];
  importedHistory?: LCodeSessionImportHistory;
}

export interface LCodeSessionResumeParams extends LCodeTaskTarget {
  model?: ModelSelection;
  thoughtLevel?: string;
  mcpServers?: LCodeAgentMcpServer[];
  /**
   * 默认广播 resume 得到的历史快照，并让 shadow 订阅请求初始 snapshot。
   * 续聊发送前的 runtime 预恢复会关闭它，避免旧终态快照覆盖本地已开始的新输入运行态。
   */
  broadcastSnapshot?: boolean;
}

export interface LCodeSessionListParams extends LCodeSessionWorkspaceTarget {
  includeArchived?: boolean;
  limit?: number;
}

export interface LCodeSessionReadParams extends LCodeTaskTarget {
  deliveryKind?: LCodeDeliveryKind;
  messageLimit?: number;
  afterSeq?: number;
}

export interface LCodeSessionMessagesParams extends LCodeTaskTarget {
  afterMessageId?: string;
  limit?: number;
}

export interface LCodeSessionEventsParams extends LCodeTaskTarget {
  afterSeq?: number;
  limit?: number;
}

export interface LCodeSessionSetModelParams extends LCodeTaskTarget {
  model: ModelSelection;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface LCodeSessionSetThoughtLevelParams extends LCodeTaskTarget {
  thoughtLevel?: string;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface LCodeSessionSetModeParams extends LCodeTaskTarget {
  mode: LCodeSessionMode;
  expectedRevision?: number;
}

export interface LCodeSessionSubscribeParams extends LCodeTaskTarget {
  deliveryKind: LCodeDeliveryKind;
  afterSeq?: number;
  includeSnapshot?: boolean;
  eventCoalescing?: {
    mode: "background-summary";
    intervalMs?: number;
  };
}

export type LCodeSessionServiceEvent =
  | { type: "session.event"; event: LCodeSessionEvent }
  | { type: "state.updated"; notification: LCodeStateUpdatedNotification }
  | { type: "permission.request"; request: LCodePermissionRequestParams }
  | { type: "userInput.request"; request: LCodeUserInputRequestParams }
  | {
      type: "userInput.response";
      requestId: string;
      response: LCodeUserInputResponse;
    }
  | { type: "snapshot"; snapshot: LCodeSessionStateSnapshot };

export interface LCodeSessionInitializeResult {
  available: boolean;
  workspaceKey: string;
  protocolName?: string;
  protocolVersion?: number;
  transportKind?: "stdio" | "websocket";
  reason?: string;
  reasonCode?: "provider_not_ready";
}

export interface LCodeSessionWorkspaceRuntimeIdentity {
  generation: number;
  identity: string;
  processId?: number;
  workspaceKey: string;
}

export interface ILCodeSessionService {
  initializeWorkspace(params: LCodeSessionWorkspaceTarget): Promise<LCodeSessionInitializeResult>;
  getWorkspaceRuntimeIdentity(
    params: LCodeSessionWorkspaceTarget,
  ): Promise<LCodeSessionWorkspaceRuntimeIdentity>;
  readWorkspacePresentation(
    params: LCodeSessionReadWorkspacePresentationParams,
  ): Promise<LCodeWorkspacePresentation>;
  createSession(params: LCodeSessionCreateParams): Promise<LCodeSessionStateSnapshot>;
  resumeSession(params: LCodeSessionResumeParams): Promise<LCodeSessionStateSnapshot>;
  listSessions(params: LCodeSessionListParams): Promise<LCodeSessionInfo[]>;
  readSession(params: LCodeSessionReadParams): Promise<LCodeSessionStateSnapshot>;
  readSessionMessages(params: LCodeSessionMessagesParams): Promise<LCodeMessageWithParts[]>;
  readSessionEvents(params: LCodeSessionEventsParams): Promise<LCodeSessionEvent[]>;
  promoteDeferredDraftSession(params: LCodeTaskTarget): Promise<void>;
  closeSession(params: LCodeTaskTarget): Promise<void>;
  closeDeferredDraftSession(params: LCodeTaskTarget): Promise<boolean>;
  setModel(params: LCodeSessionSetModelParams): Promise<LCodeSessionStateSnapshot>;
  setThoughtLevel(params: LCodeSessionSetThoughtLevelParams): Promise<LCodeSessionStateSnapshot>;
  setMode(params: LCodeSessionSetModeParams): Promise<LCodeSessionStateSnapshot>;
  // renderer 订阅面走 agentService 的 conversation/sessions-index 帧通道。
}

export const ILCodeSessionService = createServiceDescriptor<ILCodeSessionService>(
  ServiceChannels.LCodeSession,
);
