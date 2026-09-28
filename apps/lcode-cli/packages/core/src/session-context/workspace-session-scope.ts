import { relative, resolve } from "node:path";
import type { SessionInfo } from "@lcode/contracts";

export function canReadSessionContextFromWorkspace(
  session: Pick<SessionInfo, "directory" | "workspaceID">,
  workspace: { workspaceIdentity?: string; workspaceRoot: string },
): boolean {
  const currentIdentity = workspace.workspaceIdentity?.trim();
  const targetIdentity = session.workspaceID?.trim();

  if (currentIdentity) return targetIdentity === currentIdentity;
  if (targetIdentity) return false;

  return sameNormalizedDirectory(workspace.workspaceRoot, session.directory);
}

function sameNormalizedDirectory(left: string, right: string): boolean {
  if (!left || !right) return false;
  return relative(resolve(left), resolve(right)) === "";
}
