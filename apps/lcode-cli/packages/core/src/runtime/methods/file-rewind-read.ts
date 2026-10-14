import type {
  FileSystemPort,
  Logger,
  MessageId,
  SessionEvent,
  SessionEventType,
  SessionEventStorePort,
  SessionId,
  ToolArtifactStorePort,
  TraceContext,
  TurnId,
} from "@lcode/contracts";
import { applyWorkspaceFileRewind } from "./file-rewind.js";
import type { WorkspaceFileRewindApplyResult } from "../types.js";
import type { WorkspaceFileRewindPreview } from "../types.js";
import { buildWorkspaceFileRewindPlan } from "./file-rewind-plan.js";
import { toPreview } from "./file-rewind-state.js";

/** 只读预览源不要求 AgentRuntime，不能为历史详情启动执行身份。 */
export interface WorkspaceFileRewindReadSource {
  sessionId: SessionId;
  workspaceRoot: string;
  rootTraceContext: TraceContext;
  eventStore: Pick<SessionEventStorePort, "getEvents">;
  artifactStore?: Pick<ToolArtifactStorePort, "readToolResultArtifact">;
  fileSystemPort?: Pick<FileSystemPort, "readTextFile">;
}

export interface WorkspaceFileRewindWriteSource extends Omit<
  WorkspaceFileRewindReadSource,
  "fileSystemPort"
> {
  fileSystemPort?: Pick<FileSystemPort, "readTextFile" | "writeTextFile" | "removeFile">;
  logger?: Logger;
  createEvent(type: SessionEventType, payload: unknown, trace: TraceContext): SessionEvent;
  appendEvent(event: SessionEvent, trace: TraceContext): Promise<unknown>;
}

/** 只供已授权命令 owner 调用，同一算法/补偿 journal，不建立可执行 runtime。 */
export function applyWorkspaceFileRewindFromSources(
  source: WorkspaceFileRewindWriteSource,
  options: { targetMessageIds: MessageId[]; targetTurnId?: TurnId },
): Promise<WorkspaceFileRewindApplyResult> {
  return applyWorkspaceFileRewind.call(source, options);
}

export async function previewWorkspaceFileRewindFromSources(
  source: WorkspaceFileRewindReadSource,
  options: {
    targetMessageIds?: MessageId[];
    targetTurnId?: TurnId;
    abortSignal?: AbortSignal;
  } = {},
): Promise<WorkspaceFileRewindPreview> {
  return toPreview(await buildWorkspaceFileRewindPlan.call(source, options));
}
