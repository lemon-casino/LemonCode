import { isAbsolute, resolve } from "node:path";
import { applyPatch, type StructuredPatch } from "diff";
import {
  RewindScope,
  SessionEventType,
  getCurrentTraceContext,
  parseWorkspaceCheckpointArtifact,
} from "../deps.js";
import type {
  CheckpointCreatedPayload,
  MessageId,
  TraceContext,
  TurnId,
  WorkspaceCheckpointArtifact,
} from "../deps.js";
import {
  selectCheckpointForRewind,
  selectCheckpointsForMessages,
  throwIfTurnAborted,
} from "../helpers/index.js";
import type { WorkspaceFileRewindUnsafeFile } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type {
  PlannedFileState,
  FileCheckpointOperation,
  WorkspaceFileRewindPlan,
  FileAggregate,
  IgnoredFileAggregate,
} from "./file-rewind-state.js";
import {
  readCurrentFileState,
  hashContent,
  ensureFileAggregate,
  markUnsafe,
  addIgnoredFile,
  toSafeFile,
  toUnsafeFile,
  toIgnoredFile,
  compareByPath,
} from "./file-rewind-state.js";

export async function buildWorkspaceFileRewindPlan(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    targetMessageIds?: MessageId[];
    targetTurnId?: TurnId;
    traceContext?: TraceContext;
  },
): Promise<WorkspaceFileRewindPlan> {
  const traceContext = options.traceContext ?? getCurrentTraceContext() ?? this.rootTraceContext;
  if (!this.artifactStore || !this.fileSystemPort) {
    return {
      canApply: false,
      ignoredFiles: [],
      operations: [],
      safeFiles: [],
      unsafeFiles: [
        {
          operationCount: 1,
          path: "workspace",
          reason: !this.artifactStore ? "checkpoint_unreadable" : "file_read_failed",
          toolNames: [],
          message: !this.artifactStore
            ? "ArtifactStore is not configured."
            : "FileSystemPort is not configured.",
        },
      ],
    };
  }

  const events = await this.eventStore.getEvents(this.sessionId);
  const checkpoints = resolveTargetCheckpoints(events, {
    targetCheckpointId: options.targetCheckpointId,
    targetMessageId: options.targetMessageId,
    targetMessageIds: options.targetMessageIds,
  });
  if (checkpoints.length === 0) {
    return {
      canApply: false,
      ignoredFiles: [],
      operations: [],
      safeFiles: [],
      unsafeFiles: [],
    };
  }

  const artifacts: Array<{
    artifact: WorkspaceCheckpointArtifact;
    checkpoint: CheckpointCreatedPayload;
  }> = [];
  const unreadableFiles: WorkspaceFileRewindUnsafeFile[] = [];

  for (const checkpoint of checkpoints) {
    throwIfTurnAborted(options.abortSignal);
    try {
      const read = await this.artifactStore.readToolResultArtifact(
        {
          uri: checkpoint.snapshotRef,
          trace: traceContext,
        },
        { signal: options.abortSignal },
      );
      artifacts.push({
        artifact: parseWorkspaceCheckpointArtifact(JSON.parse(read.content)),
        checkpoint,
      });
    } catch (error) {
      unreadableFiles.push({
        operationCount: Math.max(1, checkpoint.fileCount ?? 1),
        path: `checkpoint:${checkpoint.checkpointId}`,
        reason: "checkpoint_unreadable",
        toolNames: [],
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const ignoredByPath = new Map<string, IgnoredFileAggregate>();
  const operations: FileCheckpointOperation[] = [];
  const unsupportedByPath = new Map<string, FileAggregate>();

  for (const { artifact, checkpoint } of artifacts) {
    if (isIgnoredShellTool(artifact.toolName)) {
      for (const file of artifact.files) {
        addIgnoredFile(
          ignoredByPath,
          resolveCheckpointFilePath(this.workspaceRoot, file.path),
          artifact.toolName,
        );
      }
      continue;
    }

    for (const file of artifact.files) {
      // Write/ApplyPatch checkpoint 会保留模型传入的工作区相对路径，而
      // FileSystemPort 只接受绝对路径。若不在计划阶段按 runtime workspace root
      // 解析，安全文件会被误报 file_read_failed，组合 rewind 只返回 blocked。
      const filePath = resolveCheckpointFilePath(this.workspaceRoot, file.path);
      const afterContent = resolveCheckpointAfterContent(file);
      if (afterContent === undefined) {
        markUnsafe(unsupportedByPath, {
          action: file.existedBefore && file.beforeContent !== null ? "restore" : "delete",
          path: filePath,
          reason: "unsupported_checkpoint",
          toolName: artifact.toolName,
        });
        continue;
      }

      operations.push({
        action: file.existedBefore && file.beforeContent !== null ? "restore" : "delete",
        afterContent,
        artifact,
        beforeContent: file.beforeContent,
        checkpoint,
        path: filePath,
        toolName: artifact.toolName,
      });
    }
  }

  const simulatedByPath = new Map<string, PlannedFileState>();
  const safeByPath = new Map<string, FileAggregate>();
  const unsafeByPath = new Map<string, FileAggregate>(unsupportedByPath);
  const applyOperations: FileCheckpointOperation[] = [];

  for (const operation of [...operations].reverse()) {
    throwIfTurnAborted(options.abortSignal);
    const aggregate = ensureFileAggregate(safeByPath, operation);
    aggregate.operationCount += 1;
    aggregate.toolNames.add(operation.toolName);
    aggregate.action = operation.action;

    if (unsafeByPath.has(operation.path)) {
      continue;
    }

    const currentState =
      simulatedByPath.get(operation.path) ??
      (await readCurrentFileState.call(this, operation.path, traceContext, options.abortSignal));
    if ("reason" in currentState) {
      markUnsafe(unsafeByPath, {
        action: operation.action,
        message: currentState.message,
        path: operation.path,
        reason: currentState.reason,
        toolName: operation.toolName,
      });
      continue;
    }

    const expectedHash = hashContent(operation.afterContent);
    if (currentState.hash !== expectedHash) {
      markUnsafe(unsafeByPath, {
        action: operation.action,
        currentHash: currentState.hash ?? "missing",
        expectedHash,
        path: operation.path,
        reason: "external_modified",
        toolName: operation.toolName,
      });
      continue;
    }

    simulatedByPath.set(operation.path, {
      content: operation.beforeContent,
      exists: operation.beforeContent !== null,
      hash: hashContent(operation.beforeContent),
    });
    applyOperations.push(operation);
  }

  for (const [path, unsafe] of unsafeByPath) {
    safeByPath.delete(path);
    unsafe.operationCount = Math.max(
      unsafe.operationCount,
      operations.filter((operation) => operation.path === path).length,
    );
  }

  const safeFiles = Array.from(safeByPath.values()).map(toSafeFile).sort(compareByPath);
  const unsafeFiles = [
    ...unreadableFiles,
    ...Array.from(unsafeByPath.values()).map(toUnsafeFile),
  ].sort(compareByPath);
  const ignoredFiles = Array.from(ignoredByPath.values()).map(toIgnoredFile).sort(compareByPath);

  return {
    canApply: safeFiles.length > 0 && unsafeFiles.length === 0,
    ignoredFiles,
    operations: unsafeFiles.length === 0 ? applyOperations : [],
    safeFiles,
    unsafeFiles,
  };
}

function resolveCheckpointFilePath(workspaceRoot: string, path: string): string {
  return isAbsolute(path) ? path : resolve(workspaceRoot, path);
}

function resolveTargetCheckpoints(
  events: Parameters<typeof selectCheckpointForRewind>[0],
  target: {
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    targetMessageIds?: MessageId[];
    targetTurnId?: TurnId;
  },
): CheckpointCreatedPayload[] {
  const targetMessageIds =
    target.targetMessageIds && target.targetMessageIds.length > 0
      ? target.targetMessageIds
      : target.targetMessageId
        ? [target.targetMessageId]
        : [];
  if (targetMessageIds.length > 0) {
    const checkpoints = selectCheckpointsForMessages(events, targetMessageIds);
    if (checkpoints.length > 0 || !target.targetTurnId) {
      return checkpoints;
    }
  }

  if (target.targetTurnId && !String(target.targetTurnId).includes("~")) {
    // 旧 TurnStarted 没有 user messageId，无法通过 rowId->messageId
    // 找到 workspace checkpoint；普通 turn 可用事件 turnId 精确兜底。split
    // product turn 带 "~q" 后缀，不能按 runtime turnId 兜底，避免串到其他 queued turn。
    return events
      .filter((event) => event.type === SessionEventType.CheckpointCreated)
      .filter((event) => String(event.turnId ?? "") === String(target.targetTurnId))
      .map((event) => event.payload)
      .filter((payload): payload is CheckpointCreatedPayload => {
        const checkpoint = payload as Partial<CheckpointCreatedPayload>;
        return checkpoint.scope === RewindScope.Workspace || checkpoint.scope === RewindScope.Both;
      });
  }

  const checkpoint = selectCheckpointForRewind(events, target.targetCheckpointId);
  return checkpoint ? [checkpoint] : [];
}

function resolveCheckpointAfterContent(
  file: WorkspaceCheckpointArtifact["files"][number],
): string | null | undefined {
  const afterContent = (file as { afterContent?: unknown }).afterContent;
  if (typeof afterContent === "string") {
    return afterContent;
  }

  if (!file.existedBefore && file.beforeContent === null && file.structuredPatch.length === 0) {
    return undefined;
  }

  const beforeContent = file.beforeContent ?? "";
  const patch: StructuredPatch = {
    oldFileName: file.path,
    newFileName: file.path,
    oldHeader: undefined,
    newHeader: undefined,
    hunks: file.structuredPatch,
  };
  const patched = applyPatch(beforeContent, patch, {
    autoConvertLineEndings: false,
    fuzzFactor: 0,
  });
  return typeof patched === "string" ? patched : undefined;
}

function isIgnoredShellTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized === "bash" ||
    normalized === "shell" ||
    normalized.includes("terminal") ||
    normalized.endsWith("shell")
  );
}
