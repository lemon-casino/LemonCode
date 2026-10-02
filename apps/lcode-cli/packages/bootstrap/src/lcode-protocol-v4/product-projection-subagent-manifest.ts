// 同事件内由 subagent rows、交互和后台事实物化权威 manifest。
// host 是 ProductProjection 原实例的窄借用视图；函数不持有副本或另建 owner。
import type { ProductProjectionState, SessionSubagentsSeed } from "./product-projection-state.js";
import type {
  ConversationDelta,
  SubagentProjectionState,
  SubagentRow,
  ConversationRow,
  RunningSubagentSummary,
} from "@lcode/shared/lcode-protocol-v4";
import { findRow } from "./product-projection-rows.js";

type SeedSubagentsHost = Pick<
  ProductProjectionState,
  "snapshot" | "invalidSubagentChildSessionIds"
>;

type ShouldMaterializeSubagentProjectionHost = Pick<
  ProductProjectionState,
  "snapshot" | "rowIndexById" | "hydrationAccumulator"
>;

type MaterializeSubagentProjectionHost = Pick<
  ProductProjectionState,
  "snapshot" | "rowIndexById" | "subagentRowIdByAgentId" | "invalidSubagentChildSessionIds"
>;

/**
 * 冷恢复的 subagent store 校验种子。transcript 可以恢复可见 row，但只有 session
 * store 能证明 child 已持久化为 subagent_child；因此在 candidate publisher 发布前
 * 用该种子整体替换 manifest，旧版本遗留的幽灵 child 不得进入 UI 权威态。
 */
export function seedSubagents(host: SeedSubagentsHost, seed: SessionSubagentsSeed): void {
  const childSessionIds = [...new Set(seed.childSessionIds)];
  const allowed = new Set(childSessionIds);
  host.invalidSubagentChildSessionIds = new Set(
    host.snapshot.rows.window.flatMap((row) =>
      row.kind === "subagent" && row.childSessionId && !allowed.has(row.childSessionId)
        ? [row.childSessionId]
        : [],
    ),
  );
  const running = seed.running.filter((item) => allowed.has(item.childSessionId));
  host.snapshot = {
    ...host.snapshot,
    subagents: {
      // 非空 cold manifest 必须至少从 1 开始；renderer 用 0 区分尚未建立权威态，
      // 否则旧 session 的 stateRevision=0 会让 child tab 失效同步被永久跳过。
      revision: Math.max(childSessionIds.length > 0 ? 1 : 0, Math.floor(seed.revision)),
      childSessionIds,
      running,
      endedTotal: Math.max(0, childSessionIds.length - running.length),
    },
  };
}

/**
 * Subagent row 与摘要投影在同一个 event transaction 内 materialize。
 * 旧 UI 在 spawn 后另查 session/subagents；7 个并发 child 中查询若恰好落在
 * 最后一个 session 持久化前，就会永久缓存 6，直到切换 Session 才重查。现在 renderer
 * 只消费这里随 row 一起提交的完整态，不再存在事件/查询双时钟。
 */
export function shouldMaterializeSubagentProjection(
  host: ShouldMaterializeSubagentProjectionHost,
  reduced: readonly ConversationDelta[],
): boolean {
  // 性能问题根因：cold hydration 曾让 checkpoint 等无关事件也扫描全部历史 rows。
  // 这里只在尚未发布的 batch accumulator 内按 materializer 的真实输入准入；live 与
  // strict fallback 仍走原路径，batch 之后直接写权威 manifest 的 store seed 不受影响。
  if (!host.hydrationAccumulator) return true;

  for (const delta of reduced) {
    switch (delta.op) {
      case "row.appended":
      case "row.upserted":
        if (delta.row.kind === "subagent" || findRow(host, delta.row.rowId)?.kind === "subagent") {
          return true;
        }
        break;
      case "row.delta":
        if (findRow(host, delta.rowId)?.kind === "subagent") return true;
        break;
      case "row.removed":
        // 后缀删除可能同时移除 subagent row；不为判定再预扫描一次 rows。
        return true;
      case "state.updated":
        if (
          delta.patch.pendingInteractions !== undefined ||
          delta.patch.backgroundWorks !== undefined
        ) {
          return true;
        }
        break;
      default: {
        const exhaustiveDelta: never = delta;
        return exhaustiveDelta;
      }
    }
  }
  return false;
}

export function materializeSubagentProjection(
  host: MaterializeSubagentProjectionHost,
  reduced: readonly ConversationDelta[],
): ConversationDelta[] {
  const previous: SubagentProjectionState = host.snapshot.subagents ?? {
    revision: 0,
    childSessionIds: [],
    running: [],
    endedTotal: 0,
  };
  const previousRunningById = new Map(previous.running.map((item) => [item.childSessionId, item]));
  const latestRowByChildId = new Map<string, SubagentRow>();
  const collectSubagentRow = (row: SubagentRow | null): void => {
    if (row?.childSessionId && !host.invalidSubagentChildSessionIds.has(row.childSessionId)) {
      latestRowByChildId.set(row.childSessionId, row);
    }
  };
  // 性能问题根因：旧实现先复制完整 rows 数组，再扫描所有普通 conversation rows。
  // subagentRowIdByAgentId 已是 reducer 查找用的派生索引；这里按 rowId 去重，并通过
  // rowIndexById 恢复当前时间线顺序；row.removed 应用后会清理已失效的 alias。
  const currentRowIds = new Set(host.subagentRowIdByAgentId.values());
  for (const delta of reduced) {
    if (delta.op === "row.upserted") {
      if (delta.row.kind === "subagent" || findRow(host, delta.row.rowId)?.kind === "subagent") {
        currentRowIds.add(delta.row.rowId);
      }
    } else if (delta.op === "row.delta" && findRow(host, delta.rowId)?.kind === "subagent") {
      currentRowIds.add(delta.rowId);
    }
  }
  const currentRows: Array<{ rowIndex: number; row: ConversationRow }> = [];
  for (const rowId of currentRowIds) {
    const rowIndex = host.rowIndexById.get(rowId);
    const row = rowIndex === undefined ? undefined : host.snapshot.rows.window[rowIndex];
    if (rowIndex !== undefined && row !== undefined) currentRows.push({ rowIndex, row });
  }
  currentRows.sort((left, right) => left.rowIndex - right.rowIndex);
  for (const { row } of currentRows) {
    collectSubagentRow(prospectiveSubagentRow(row, reduced, 0));
  }
  for (let index = 0; index < reduced.length; index += 1) {
    const delta = reduced[index]!;
    if (delta.op !== "row.appended") continue;
    collectSubagentRow(prospectiveSubagentRow(delta.row, reduced, index + 1));
  }

  let pendingInteractions = host.snapshot.pendingInteractions;
  let backgroundWorks = host.snapshot.backgroundWorks;
  for (const delta of reduced) {
    if (delta.op !== "state.updated") continue;
    if (delta.patch.pendingInteractions !== undefined) {
      pendingInteractions = delta.patch.pendingInteractions;
    }
    if (delta.patch.backgroundWorks !== undefined) {
      backgroundWorks = delta.patch.backgroundWorks;
    }
  }
  const waitingChildIds = new Set<string>();
  // workspace-hook-trust 新增的 hook review 交互 payload 没有 origin 字段，跳过守卫避免误读。
  for (const interaction of pendingInteractions) {
    if (!("origin" in interaction.payload)) continue;
    const origin = interaction.payload.origin;
    if (origin?.kind === "subagent") waitingChildIds.add(origin.childSessionId);
  }
  const blockedChildIds = new Set(
    backgroundWorks.flatMap((work) =>
      work.kind === "subagent" && work.status === "running" && work.blocked && work.childSessionId
        ? [work.childSessionId]
        : [],
    ),
  );

  const childSessionIds = [...latestRowByChildId.keys()];
  const running: RunningSubagentSummary[] = [];
  for (const [childSessionId, row] of latestRowByChildId) {
    if (row.status !== "running") continue;
    const previousItem = previousRunningById.get(childSessionId);
    const title = previousItem?.title || row.summaryText.trim() || row.subagentType;
    running.push({
      childSessionId,
      agentId: row.entityId,
      ...(row.parentToolCallId ? { toolCallId: row.parentToolCallId } : {}),
      subagentType: row.subagentType,
      title,
      status: waitingChildIds.has(childSessionId)
        ? "waiting"
        : blockedChildIds.has(childSessionId)
          ? "blocked"
          : "running",
      ...(row.startedAt !== undefined ? { startedAt: row.startedAt } : {}),
    });
  }
  running.sort(
    (left, right) =>
      (right.startedAt ?? 0) - (left.startedAt ?? 0) ||
      right.childSessionId.localeCompare(left.childSessionId),
  );
  const endedTotal = childSessionIds.length - running.length;
  const semanticState = { childSessionIds, running, endedTotal };
  if (
    JSON.stringify(semanticState) ===
    JSON.stringify({
      childSessionIds: previous.childSessionIds,
      running: previous.running,
      endedTotal: previous.endedTotal,
    })
  ) {
    return [];
  }
  return [
    {
      op: "state.updated",
      patch: {
        subagents: {
          revision: previous.revision + 1,
          ...semanticState,
        },
      },
    },
  ];
}

function prospectiveSubagentRow(
  row: ConversationRow,
  reduced: readonly ConversationDelta[],
  startIndex: number,
): SubagentRow | null {
  let prospective: ConversationRow | null = row;
  for (let index = startIndex; index < reduced.length && prospective; index += 1) {
    const delta = reduced[index]!;
    switch (delta.op) {
      case "row.appended":
      case "state.updated":
        break;
      case "row.upserted":
        if (delta.row.rowId === prospective.rowId) prospective = delta.row;
        break;
      case "row.delta":
        if (
          delta.rowId === prospective.rowId &&
          delta.path === "summaryText" &&
          prospective.kind === "subagent"
        ) {
          prospective = {
            ...prospective,
            summaryText: prospective.summaryText + delta.append,
          };
        }
        break;
      case "row.removed":
        if (prospective.rowId >= delta.fromRowId) prospective = null;
        break;
      default: {
        const exhaustiveDelta: never = delta;
        return exhaustiveDelta;
      }
    }
  }
  return prospective?.kind === "subagent" ? prospective : null;
}
