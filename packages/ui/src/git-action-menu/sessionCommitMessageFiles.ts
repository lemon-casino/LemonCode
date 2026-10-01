import type {
  V4ConversationFileChangesParams,
  V4ConversationFileChangesResult,
  V4ConversationRowsRangeParams,
  V4ConversationRowsRangeResult,
} from "@lcode/shared/lcode-protocol-v4";

export interface SessionCommitFileReader {
  rowsRange(params: V4ConversationRowsRangeParams): Promise<V4ConversationRowsRangeResult>;
  fileChanges(params: V4ConversationFileChangesParams): Promise<V4ConversationFileChangesResult>;
}

/** 读取有效分支的历史，不从 AI 文案猜路径；子会话 id 必须来自宿主目录/投影。 */
export async function collectSessionCommitFilePaths(
  reader: SessionCommitFileReader,
  sessionIds: readonly string[],
  isCurrent: () => boolean,
): Promise<string[]> {
  const paths = new Set<string>();
  const queue = [...new Set(sessionIds)];
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length && isCurrent()) {
        const sessionId = queue.shift()!;
        let beforeRowId: number | undefined;
        let logEpoch: string | undefined;
        while (isCurrent()) {
          const page = await reader.rowsRange({ sessionId, limit: 200, beforeRowId });
          if (!isCurrent()) break;
          if (logEpoch !== undefined && logEpoch !== page.atLogEpoch)
            throw new Error("commit_file_scope_changed");
          logEpoch = page.atLogEpoch;
          for (const row of page.rows) {
            if (!isCurrent()) break;
            if (
              row.kind !== "turnHeader" ||
              !row.entityId ||
              !row.fileChanges?.files ||
              row.fileChanges.state === "reverted"
            )
              continue;
            const changes = await reader.fileChanges({
              sessionId,
              target: { rowId: row.rowId, entityId: row.entityId },
              baseRevision: page.atRevision,
              baseLogEpoch: page.atLogEpoch,
            });
            if (!isCurrent()) break;
            if (changes.state !== "reverted")
              for (const item of changes.items) paths.add(item.path);
          }
          if (!page.hasMore) break;
          const next = page.rows[0]?.rowId;
          if (next === undefined || (beforeRowId !== undefined && next >= beforeRowId))
            throw new Error("commit_file_scope_cursor_invalid");
          beforeRowId = next;
        }
      }
    }),
  );
  return isCurrent() ? [...paths].sort() : [];
}
