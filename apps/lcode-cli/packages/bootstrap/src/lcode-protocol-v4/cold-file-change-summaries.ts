import {
  RewindScope,
  SessionEventType,
  parseCheckpointCreatedPayload,
  parseWorkspaceCheckpointArtifact,
  type DiffHunk,
  type SessionEvent,
  type TurnFileChangeSummary,
  type TurnId,
} from "@lcode/contracts";
import type { V4ConversationFileChangesResult } from "@lcode/shared/lcode-protocol-v4";
import { structuredPatch } from "diff";
import { resolveWorkspaceCheckpointAfterContent as resolveCheckpointAfterContent } from "../checkpoint-file-content.js";

interface FileChangeAggregate {
  afterContent?: string;
  beforeContent: string | null;
  fallbackAdditions: number;
  fallbackDeletions: number;
  patches: DiffHunk[];
  path: string;
  toolNames: Set<string>;
  writeCount: number;
}

interface WorkspaceCheckpointWithTurn {
  checkpoint: ReturnType<typeof parseCheckpointCreatedPayload>;
  turnId: string | null;
}

type ReadArtifact = (snapshotRef: string) => Promise<string>;

function isSplitProductTurnId(turnId: string | null | undefined): boolean {
  return Boolean(turnId?.includes("~"));
}

function isWorkspaceCheckpoint(
  checkpoint: ReturnType<typeof parseCheckpointCreatedPayload>,
): boolean {
  return checkpoint.scope === RewindScope.Workspace || checkpoint.scope === RewindScope.Both;
}

function workspaceCheckpoints(events: readonly SessionEvent[]): WorkspaceCheckpointWithTurn[] {
  return events
    .filter((event) => event.type === SessionEventType.CheckpointCreated)
    .map((event) => ({
      checkpoint: parseCheckpointCreatedPayload(event.payload),
      turnId: event.turnId ? String(event.turnId) : null,
    }))
    .filter(({ checkpoint }) => isWorkspaceCheckpoint(checkpoint));
}

function selectWorkspaceCheckpointsForFileSummary(
  events: readonly SessionEvent[],
  messageIds: readonly string[],
  targetTurnId?: TurnId | null,
): WorkspaceCheckpointWithTurn[] {
  const messageIdSet = new Set(messageIds);
  const checkpoints = workspaceCheckpoints(events);
  const byMessageId = checkpoints.filter(({ checkpoint }) =>
    messageIdSet.has(String(checkpoint.targetMessageId ?? checkpoint.messageId)),
  );
  if (byMessageId.length > 0 || !targetTurnId || isSplitProductTurnId(String(targetTurnId))) {
    return byMessageId;
  }

  // 旧事件和缺失 user messageId 映射的普通 TurnStarted
  // 只能用事件 turnId 兜底。split product turn 带 "~q" 后缀，禁止按 runtime turnId
  // 合并，避免 queued/drained 场景串轮。
  return checkpoints.filter(({ turnId }) => turnId === String(targetTurnId));
}

function readModelCompleteFileChangesFallback(
  events: readonly SessionEvent[],
  targetTurnId?: TurnId | null,
): V4ConversationFileChangesResult | null {
  if (!targetTurnId || isSplitProductTurnId(String(targetTurnId))) {
    return null;
  }
  const event = [...events]
    .reverse()
    .find(
      (candidate) =>
        candidate.type === SessionEventType.ModelComplete &&
        String(candidate.turnId ?? "") === String(targetTurnId),
    );
  const fileChanges = (event?.payload as { fileChanges?: unknown } | undefined)?.fileChanges;
  if (typeof fileChanges !== "object" || fileChanges === null) {
    return null;
  }
  const rawItems = (fileChanges as { items?: unknown }).items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return null;
  }
  const items = rawItems
    .flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const record = item as Record<string, unknown>;
      if (typeof record.path !== "string" || record.path.length === 0) return [];
      return [
        {
          path: record.path,
          additions:
            typeof record.additions === "number" && record.additions > 0 ? record.additions : 0,
          deletions:
            typeof record.deletions === "number" && record.deletions > 0 ? record.deletions : 0,
          writeCount:
            typeof record.writeCount === "number" && record.writeCount > 0 ? record.writeCount : 1,
          toolNames: [] as string[],
          patches: [] as DiffHunk[],
        },
      ];
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  if (items.length === 0) return null;
  return {
    files: items.length,
    additions: items.reduce((total, item) => total + item.additions, 0),
    deletions: items.reduce((total, item) => total + item.deletions, 0),
    items,
  };
}

async function aggregateWorkspaceCheckpoints(
  checkpoints: readonly WorkspaceCheckpointWithTurn[],
  readArtifact: ReadArtifact,
): Promise<V4ConversationFileChangesResult> {
  const byPath = new Map<string, FileChangeAggregate>();

  // checkpoint 顺序就是同一轮文件写入顺序，必须串行聚合 first-before → final-after。
  for (const { checkpoint } of checkpoints) {
    const artifact = parseWorkspaceCheckpointArtifact(
      JSON.parse(await readArtifact(checkpoint.snapshotRef)),
    );
    for (const file of artifact.files) {
      const fallback = countPatchLines(file.structuredPatch);
      const afterContent = resolveCheckpointAfterContent(file);
      const existing = byPath.get(file.path);
      if (!existing) {
        byPath.set(file.path, {
          afterContent,
          beforeContent: file.beforeContent,
          fallbackAdditions: fallback.additions,
          fallbackDeletions: fallback.deletions,
          patches: file.structuredPatch,
          path: file.path,
          toolNames: new Set([artifact.toolName]),
          writeCount: 1,
        });
        continue;
      }
      existing.afterContent = afterContent ?? existing.afterContent;
      existing.fallbackAdditions += fallback.additions;
      existing.fallbackDeletions += fallback.deletions;
      existing.patches.push(...file.structuredPatch);
      existing.toolNames.add(artifact.toolName);
      existing.writeCount += 1;
    }
  }

  const items = Array.from(byPath.values())
    .map((entry) => {
      const patches =
        entry.afterContent === undefined
          ? entry.patches
          : createFinalPatch(entry.path, entry.beforeContent ?? "", entry.afterContent);
      const stat =
        entry.afterContent === undefined
          ? {
              additions: entry.fallbackAdditions,
              deletions: entry.fallbackDeletions,
            }
          : countPatchLines(patches);
      return {
        path: entry.path,
        additions: stat.additions,
        deletions: stat.deletions,
        writeCount: entry.writeCount,
        toolNames: Array.from(entry.toolNames).sort(),
        patches,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    files: items.length,
    additions: items.reduce((total, item) => total + item.additions, 0),
    deletions: items.reduce((total, item) => total + item.deletions, 0),
    items,
  };
}

export async function readConversationFileChangesFromEvents(input: {
  events: readonly SessionEvent[];
  messageIds: readonly string[];
  readArtifact: ReadArtifact;
  targetTurnId?: TurnId | null;
}): Promise<V4ConversationFileChangesResult> {
  const checkpoints = selectWorkspaceCheckpointsForFileSummary(
    input.events,
    input.messageIds,
    input.targetTurnId,
  );
  const result = await aggregateWorkspaceCheckpoints(checkpoints, input.readArtifact);
  if (result.items.length > 0) return result;
  return (
    readModelCompleteFileChangesFallback(input.events, input.targetTurnId) ?? {
      files: 0,
      additions: 0,
      deletions: 0,
      items: [],
    }
  );
}

export async function buildColdFileChangeSummaries(input: {
  events: readonly SessionEvent[];
  messageIds: readonly string[];
  onArtifactError?: (messageId: string, error: unknown) => void;
  readArtifact: ReadArtifact;
}): Promise<ReadonlyMap<string, TurnFileChangeSummary>> {
  const durableMessageIds = new Set(input.messageIds);
  const checkpointsByMessageId = new Map<string, WorkspaceCheckpointWithTurn[]>();
  for (const entry of workspaceCheckpoints(input.events)) {
    const messageId = String(entry.checkpoint.targetMessageId ?? entry.checkpoint.messageId);
    if (!durableMessageIds.has(messageId)) continue;
    const entries = checkpointsByMessageId.get(messageId) ?? [];
    entries.push(entry);
    checkpointsByMessageId.set(messageId, entries);
  }

  const summaries = new Map<string, TurnFileChangeSummary>();
  const groups = [...checkpointsByMessageId.entries()];
  let cursor = 0;
  const workerCount = Math.min(8, groups.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < groups.length) {
        const group = groups[cursor];
        cursor += 1;
        if (!group) continue;
        const [messageId, checkpoints] = group;
        try {
          const result = await aggregateWorkspaceCheckpoints(checkpoints, input.readArtifact);
          if (result.items.length === 0) continue;
          summaries.set(messageId, {
            additions: result.additions,
            deletions: result.deletions,
            files: result.files,
            items: result.items.map((item) => ({
              additions: item.additions,
              deletions: item.deletions,
              path: item.path,
              toolNames: item.toolNames,
              writeCount: item.writeCount,
            })),
          });
        } catch (error) {
          input.onArtifactError?.(messageId, error);
        }
      }
    }),
  );
  return summaries;
}

function createFinalPatch(path: string, beforeContent: string, afterContent: string): DiffHunk[] {
  return (
    structuredPatch(path, path, beforeContent, afterContent, undefined, undefined, {
      timeout: 5_000,
    })?.hunks ?? []
  );
}

function countPatchLines(hunks: readonly DiffHunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      if (line.startsWith("-")) deletions += 1;
    }
  }
  return { additions, deletions };
}
