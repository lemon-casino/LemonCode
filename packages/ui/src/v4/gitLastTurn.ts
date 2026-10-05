import type {
  ConversationRow,
  TurnHeaderRow,
  V4ConversationFileChangesResult,
} from "@lcode/shared/lcode-protocol-v4";
import { PROTOCOL_V4_LIMITS } from "@lcode/shared/lcode-protocol-v4";
import type { GitPaneDataset } from "@/hooks/useGitRepository.js";
import { toWorkspaceRelativePath } from "@/lib/taskChangeSummary.js";
import { isAbsoluteFilePath, joinFilePath } from "@/lib/path.js";
import type { ConversationTransport } from "@/v4/transport.js";

export function findLastCompletedAgentTurn(rows: readonly ConversationRow[]): TurnHeaderRow | null {
  let latest: TurnHeaderRow | null = null;
  for (const row of rows) {
    // 上一轮是最新已结束产品轮；不能向更旧的非空轮回退，也不能被正在运行的轮覆盖。
    if (
      row.kind === "turnHeader" &&
      row.state !== "running" &&
      row.executionKind !== "controlOnly" &&
      (!latest || row.rowId > latest.rowId)
    )
      latest = row;
  }
  return latest;
}

export function findReviewTurnHeader(
  rows: readonly ConversationRow[],
  selected: TurnHeaderRow,
): TurnHeaderRow {
  for (const row of rows) {
    if (row.kind === "turnHeader" && row.entityId === selected.entityId) return row;
  }
  return selected;
}

export async function readLastCompletedAgentTurn(options: {
  sessionId: string;
  logEpoch: string;
  rows: readonly ConversationRow[];
  hasMore: boolean;
  rowsRange: ConversationTransport["rowsRange"];
  cancelled: () => boolean;
}): Promise<TurnHeaderRow | null> {
  let rows = options.rows;
  let hasMore = options.hasMore;
  while (!options.cancelled()) {
    const found = findLastCompletedAgentTurn(rows);
    if (found) return found;
    const beforeRowId = rows[0]?.rowId;
    if (!hasMore || beforeRowId === undefined) return null;
    const page = await options.rowsRange({
      sessionId: options.sessionId,
      beforeRowId,
      limit: PROTOCOL_V4_LIMITS.rowsRangeMaxLimit,
    });
    if (options.cancelled()) return null;
    if (page.atLogEpoch !== options.logEpoch)
      throw new Error("Conversation history changed while loading file changes");
    if (page.rows.length === 0) return null;
    // 非递减游标意味着服务端没有返回更早的一页，不能无限重复读取同一个范围。
    if (page.rows[0]!.rowId >= beforeRowId)
      throw new Error("Conversation history cursor did not advance");
    rows = page.rows;
    hasMore = page.hasMore;
  }
  return null;
}

export function buildGitLastTurnDataset(
  workspacePath: string,
  details: V4ConversationFileChangesResult | null,
): GitPaneDataset {
  return {
    id: "last-turn",
    readonly: true,
    sections:
      !details || details.state === "reverted" || details.items.length === 0
        ? []
        : [
            {
              id: "last-turn",
              changes: details.items.map((item) => {
                const path = isAbsoluteFilePath(item.path)
                  ? item.path
                  : joinFilePath(workspacePath, item.path);
                const relativePath = toWorkspaceRelativePath(workspacePath, path);
                const patch = item.patches.length
                  ? [
                      `--- a/${relativePath}`,
                      `+++ b/${relativePath}`,
                      ...item.patches.flatMap((hunk) => [
                        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
                        ...hunk.lines,
                      ]),
                    ].join("\n")
                  : null;
                return {
                  path,
                  repoRelativePath: relativePath,
                  workspaceRelativePath: relativePath,
                  kind: "modified",
                  section: "last-turn",
                  added: item.additions,
                  removed: item.deletions,
                  isStaged: false,
                  isUntracked: false,
                  isConflicted: false,
                  diff: {
                    path,
                    availability: patch ? "patch" : "unavailable",
                    patch,
                    beforeContent: null,
                    afterContent: null,
                    summary: null,
                  },
                };
              }),
            },
          ],
  };
}
