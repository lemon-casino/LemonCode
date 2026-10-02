// 从候选 rows 原子物化命令 actions，不维护另一份可执行状态。
// host 是 ProductProjection 原实例的窄借用视图；函数不持有副本或另建 owner。
import type { ProductProjectionState } from "./product-projection-state.js";
import {
  type ConversationDelta,
  applyConversationDeltas,
  type ConversationRow,
  type AssistantTextRow,
} from "@lcode/shared/lcode-protocol-v4";
import type { SessionEvent } from "@lcode/contracts";
import { turnIdOf } from "./product-projection-rows.js";

type MaterializeCommandRowActionsHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "messageIdByRowId"
  | "entityIdByRowId"
  | "editTargetByEntityId"
  | "currentEditableEntityId"
  | "turnHeaderRowIdByTurnId"
>;

type MarkStableForkAssistantHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "rowIndexById"
  | "messageIdByRowId"
  | "turnHeaderRowIdByTurnId"
  | "productTurnIdByRuntimeTurnId"
  | "currentTurnId"
>;

/**
 * 基于本事件归约后的 prospective rows 原子生成 edit/retry actions。
 * action=true 必须蕴含命令层同 revision 下能解析出持久 message target；最新目标
 * 改变时同时 upsert 旧、新两行，客户端不需要按数组位置补推断。
 */
export function materializeCommandRowActions(
  host: MaterializeCommandRowActionsHost,
  reduced: ConversationDelta[],
): ConversationDelta[] {
  const prospective = applyConversationDeltas(host.snapshot, reduced);
  const rows = prospective.rows.window;
  const rowById = new Map(rows.map((row) => [row.rowId, row]));
  const latestAssistantRowIdByTurn = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== "assistantText") continue;
    const current = latestAssistantRowIdByTurn.get(row.turnId);
    if (current === undefined || row.rowId > current) {
      latestAssistantRowIdByTurn.set(row.turnId, row.rowId);
    }
  }
  const compactActive = prospective.control.activeWorks.some((work) => work.kind === "compact");
  const completionBlockingActive = prospective.control.activeWorks.length > 0;
  let latestEditable: ConversationRow | undefined;
  let latestAssistant: AssistantTextRow | undefined;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (
      !latestEditable &&
      !compactActive &&
      row.kind === "userInput" &&
      row.origin === "realUser"
    ) {
      latestEditable = row;
    }
    if (!latestAssistant && row.kind === "assistantText") {
      latestAssistant = row;
    }
    if (latestEditable && latestAssistant) break;
  }
  // 旧逻辑只按“最新完整 assistant”挑 retry，background result 的
  // synthetic turn 因此会错误获得入口；若只在 find 条件里过滤 synthetic，又会跳过
  // 最新 background assistant，让更早真实用户轮的 retry 复活。这里必须先锁定全时间线
  // 最新 assistant，再校验同轮 realUser canonical cause，保证普通 retry 不跨轮回退。
  const latestRetryable = (() => {
    if (
      completionBlockingActive ||
      !latestAssistant ||
      latestAssistant.state !== "complete" ||
      !host.messageIdByRowId.has(latestAssistant.rowId)
    ) {
      return undefined;
    }
    const headerId = host.turnHeaderRowIdByTurnId.get(latestAssistant.turnId);
    const header = headerId === undefined ? undefined : rowById.get(headerId);
    if (header?.kind !== "turnHeader" || header.state === "running") return undefined;
    const canonicalUserRow = rows.find(
      (row) =>
        row.turnId === latestAssistant.turnId &&
        row.kind === "userInput" &&
        row.origin === "realUser",
    );
    const canonicalUserEntityId = canonicalUserRow
      ? host.entityIdByRowId.get(canonicalUserRow.rowId)
      : undefined;
    if (!canonicalUserEntityId || !host.editTargetByEntityId.has(canonicalUserEntityId)) {
      return undefined;
    }
    return latestAssistant;
  })();
  const latestEditableEntityId =
    latestEditable === undefined ? null : (host.entityIdByRowId.get(latestEditable.rowId) ?? null);
  // edit action 与命令 resolver 必须共用 canonical target authority。过去 drain 分支只
  // 登记 messageId，UI 因而显示 Edit，但提交必被 resolver 以 actionUnavailable 拒绝。
  const latestEditableRowId =
    latestEditable &&
    latestEditableEntityId &&
    host.messageIdByRowId.has(latestEditable.rowId) &&
    host.editTargetByEntityId.has(latestEditableEntityId)
      ? latestEditable.rowId
      : null;
  // entity target 历史表会保留旧记录；仅撤销 row action 不足以阻止
  // entityId 直查绕过 latest-only 语义。当前可编辑 authority 与 actions 在同一次
  // materialization 中更新，resolver 不再遍历 rows，也不把 rowId 当 canonical key。
  host.currentEditableEntityId = latestEditableRowId === null ? null : latestEditableEntityId;
  const latestRetryableRowId = latestRetryable?.rowId ?? null;
  const deltas: ConversationDelta[] = [];

  for (const row of rows) {
    if (row.kind !== "turnHeader" && row.kind !== "userInput" && row.kind !== "assistantText")
      continue;
    const nextActions = { ...row.actions };
    if (row.kind === "turnHeader") {
      const canRewindFiles =
        !completionBlockingActive &&
        prospective.pendingInteractions.length === 0 &&
        row.state !== "running" &&
        row.fileChanges?.state === "active";
      if (canRewindFiles) nextActions.canRewindFiles = true;
      else delete nextActions.canRewindFiles;
    } else if (row.kind === "userInput") {
      if (row.rowId === latestEditableRowId) {
        nextActions.canEdit = true;
        nextActions.editDisposition = "rewind";
      } else {
        delete nextActions.canEdit;
        delete nextActions.editDisposition;
      }
    } else {
      if (row.rowId === latestRetryableRowId) nextActions.canRetry = true;
      else delete nextActions.canRetry;
      const headerId = host.turnHeaderRowIdByTurnId.get(row.turnId);
      const header = headerId === undefined ? undefined : rowById.get(headerId);
      const canFork =
        !compactActive &&
        row.state === "complete" &&
        header?.kind === "turnHeader" &&
        header.state === "completedSuccess" &&
        latestAssistantRowIdByTurn.get(row.turnId) === row.rowId &&
        host.messageIdByRowId.has(row.rowId);
      if (canFork) nextActions.canFork = true;
      else delete nextActions.canFork;
    }
    const actions = Object.keys(nextActions).length > 0 ? nextActions : undefined;
    if (JSON.stringify(actions) === JSON.stringify(row.actions)) continue;
    const nextRow: ConversationRow = { ...row, actions };
    if (!actions) delete nextRow.actions;
    deltas.push({ op: "row.upserted", row: nextRow });
  }
  return deltas;
}

export function markStableForkAssistant(
  host: MarkStableForkAssistantHost,
  event: SessionEvent,
): ConversationDelta[] {
  const turnId = turnIdOf(host, event);
  const rows = host.snapshot.rows.window;
  const headerRowId = host.turnHeaderRowIdByTurnId.get(turnId);
  const headerIndex = headerRowId === undefined ? undefined : host.rowIndexById.get(headerRowId);
  const startIndex = headerIndex === undefined ? 0 : headerIndex + 1;
  let row: AssistantTextRow | undefined;
  // 性能问题根因：旧实现每个成功 turn 都复制并反转完整历史 rows，冷恢复会累积为
  // 近似 O(turns * rows) 的分配与扫描。当前 turn 的行只会出现在自身 header 之后。
  for (let index = rows.length - 1; index >= startIndex; index -= 1) {
    const candidate = rows[index];
    if (candidate?.kind !== "assistantText" || candidate.turnId !== turnId) continue;
    row = candidate;
    break;
  }
  if (!row || !host.messageIdByRowId.has(row.rowId)) return [];
  return [
    {
      op: "row.upserted",
      row: {
        ...row,
        state: "complete",
        actions: { ...row.actions, canFork: true },
      },
    },
  ];
}
