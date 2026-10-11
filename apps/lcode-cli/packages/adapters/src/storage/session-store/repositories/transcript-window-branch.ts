import type { DatabaseSync } from "node:sqlite";
import type { SessionInfo, SessionTranscriptWindow } from "@lcode/contracts";

/** 仅由window读取事务调用，证明必须与返回的session/消息属于同一SQLite快照。 */
export function readBranchCutBeforeWindow(
  db: DatabaseSync,
  session: SessionInfo,
  firstMessageID: string,
): SessionTranscriptWindow["branchCutBeforeWindow"] {
  const revert = session.revert;
  const cut = revert?.branchCutAfterMessageID;
  if (!cut || !revert?.targetMessageID) return undefined;
  // 原因：cut离开有界窗口后不能凭缺席猜测分支。只在同scope锚点真实存在且
  // 按窗口相同的sequence/NULL/time/rowid顺序严格早于首条消息时提供证明。
  const before = db
    .prepare(`
    select 1 as before_window from message as cut, message as first
    where cut.session_id = ? and cut.id = ?
      and first.session_id = ? and first.id = ?
      and (cut.sequence is null, coalesce(cut.sequence, 0), cut.time_created, cut.rowid)
        < (first.sequence is null, coalesce(first.sequence, 0), first.time_created, first.rowid)
  `)
    .get(session.id, cut, session.id, firstMessageID);
  if (!before) return undefined;
  return {
    messageID: cut,
    ...(revert.branchGeneration !== undefined ? { branchGeneration: revert.branchGeneration } : {}),
  };
}
