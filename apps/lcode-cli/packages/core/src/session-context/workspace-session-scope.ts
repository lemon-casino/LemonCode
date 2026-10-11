import { relative, resolve } from "node:path";
import type { SessionInfo } from "@lcode/contracts";

export function canReadSessionContextFromWorkspace(
  session: Pick<SessionInfo, "directory" | "workspaceID" | "path">,
  workspace: { workspaceIdentity?: string; workspaceRoot: string },
): boolean {
  const currentIdentity = workspace.workspaceIdentity?.trim();
  const targetIdentity = session.workspaceID?.trim();

  if (currentIdentity) return targetIdentity === currentIdentity;
  if (targetIdentity) return false;

  // 原因：冷恢复沿session.path恢复工作区根，证据读面不能又用directory改变scope。
  // 旧记录无path或空字符串时继续按directory兼容，不改变identity优先规则。
  return sameNormalizedDirectory(workspace.workspaceRoot, session.path || session.directory);
}

function sameNormalizedDirectory(left: string, right: string): boolean {
  if (!left || !right) return false;
  return relative(resolve(left), resolve(right)) === "";
}
