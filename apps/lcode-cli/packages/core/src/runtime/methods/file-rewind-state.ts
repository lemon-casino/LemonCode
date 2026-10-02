import { createHash } from "node:crypto";
import { isFileSystemPortError } from "../deps.js";
import type {
  CheckpointCreatedPayload,
  TraceContext,
  WorkspaceCheckpointArtifact,
} from "../deps.js";
import type {
  WorkspaceFileRewindIgnoredFile,
  WorkspaceFileRewindPreview,
  WorkspaceFileRewindSafeFile,
  WorkspaceFileRewindUnsafeFile,
  WorkspaceFileRewindUnsafeReason,
} from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";

export type PlannedFileState = {
  content: string | null;
  exists: boolean;
  hash: string | null;
};

export type FileCheckpointOperation = {
  action: "restore" | "delete";
  afterContent: string | null;
  artifact: WorkspaceCheckpointArtifact;
  beforeContent: string | null;
  checkpoint: CheckpointCreatedPayload;
  path: string;
  toolName: string;
};

export type WorkspaceFileRewindPlan = WorkspaceFileRewindPreview & {
  operations: FileCheckpointOperation[];
};

export type FileRewindJournalEntry = {
  path: string;
  state: PlannedFileState;
};

export interface FileAggregate {
  action: "restore" | "delete";
  operationCount: number;
  path: string;
  toolNames: Set<string>;
  unsafe?: {
    currentHash?: string;
    expectedHash?: string;
    message?: string;
    reason: WorkspaceFileRewindUnsafeReason;
  };
}

export interface IgnoredFileAggregate {
  operationCount: number;
  path: string;
  toolNames: Set<string>;
}

export async function readCurrentFileState(
  this: AgentRuntimeInternal,
  path: string,
  traceContext: TraceContext,
  abortSignal: AbortSignal | undefined,
): Promise<PlannedFileState | { message?: string; reason: "file_read_failed" }> {
  try {
    const read = await this.fileSystemPort!.readTextFile(
      {
        path,
        trace: traceContext,
      },
      { signal: abortSignal },
    );
    return {
      content: read.content,
      exists: true,
      hash: hashContent(read.content),
    };
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "not_found") {
      return {
        content: null,
        exists: false,
        hash: hashContent(null),
      };
    }
    return {
      reason: "file_read_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function hashContent(content: string | null): string {
  if (content === null) {
    return "missing";
  }
  return createHash("sha256").update(content).digest("hex");
}

export function ensureFileAggregate(
  aggregates: Map<string, FileAggregate>,
  operation: FileCheckpointOperation,
): FileAggregate {
  const existing = aggregates.get(operation.path);
  if (existing) {
    return existing;
  }
  const aggregate: FileAggregate = {
    action: operation.action,
    operationCount: 0,
    path: operation.path,
    toolNames: new Set(),
  };
  aggregates.set(operation.path, aggregate);
  return aggregate;
}

export function markUnsafe(
  aggregates: Map<string, FileAggregate>,
  input: {
    action: "restore" | "delete";
    currentHash?: string;
    expectedHash?: string;
    message?: string;
    path: string;
    reason: WorkspaceFileRewindUnsafeReason;
    toolName: string;
  },
): void {
  const existing = aggregates.get(input.path);
  if (existing) {
    existing.operationCount += 1;
    existing.toolNames.add(input.toolName);
    existing.unsafe = {
      currentHash: input.currentHash ?? existing.unsafe?.currentHash,
      expectedHash: input.expectedHash ?? existing.unsafe?.expectedHash,
      message: input.message ?? existing.unsafe?.message,
      reason: existing.unsafe?.reason ?? input.reason,
    };
    return;
  }

  aggregates.set(input.path, {
    action: input.action,
    operationCount: 1,
    path: input.path,
    toolNames: new Set([input.toolName]),
    unsafe: {
      currentHash: input.currentHash,
      expectedHash: input.expectedHash,
      message: input.message,
      reason: input.reason,
    },
  });
}

export function addIgnoredFile(
  aggregates: Map<string, IgnoredFileAggregate>,
  path: string,
  toolName: string,
): void {
  const existing = aggregates.get(path);
  if (existing) {
    existing.operationCount += 1;
    existing.toolNames.add(toolName);
    return;
  }
  aggregates.set(path, {
    operationCount: 1,
    path,
    toolNames: new Set([toolName]),
  });
}

export function toSafeFile(file: FileAggregate): WorkspaceFileRewindSafeFile {
  return {
    action: file.action,
    operationCount: file.operationCount,
    path: file.path,
    toolNames: Array.from(file.toolNames).sort(),
  };
}

export function toUnsafeFile(file: FileAggregate): WorkspaceFileRewindUnsafeFile {
  return {
    operationCount: file.operationCount,
    path: file.path,
    reason: file.unsafe?.reason ?? "unsupported_checkpoint",
    toolNames: Array.from(file.toolNames).sort(),
    ...(file.unsafe?.message ? { message: file.unsafe.message } : {}),
    ...(file.unsafe?.expectedHash ? { expectedHash: file.unsafe.expectedHash } : {}),
    ...(file.unsafe?.currentHash ? { currentHash: file.unsafe.currentHash } : {}),
  };
}

export function toIgnoredFile(file: IgnoredFileAggregate): WorkspaceFileRewindIgnoredFile {
  return {
    operationCount: file.operationCount,
    path: file.path,
    reason: "bash_ignored",
    toolNames: Array.from(file.toolNames).sort(),
  };
}

export function compareByPath<T extends { path: string }>(left: T, right: T): number {
  return left.path.localeCompare(right.path);
}

export function toPreview(plan: WorkspaceFileRewindPlan): WorkspaceFileRewindPreview {
  return {
    canApply: plan.canApply,
    ignoredFiles: plan.ignoredFiles,
    safeFiles: plan.safeFiles,
    unsafeFiles: plan.unsafeFiles,
  };
}
