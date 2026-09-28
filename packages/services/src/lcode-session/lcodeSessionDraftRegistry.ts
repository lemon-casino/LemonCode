import type { LCodeSessionStateSnapshot } from "@lcode/shared";
import type {
  LCodeSessionWorkspaceTarget,
  LCodeTaskTarget,
} from "#src/lcode-session/lcodeSession.js";

function getWorkspaceKey(target: LCodeSessionWorkspaceTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

function getSessionScopedKey(target: LCodeTaskTarget): string {
  return `${getWorkspaceKey(target)}\0${target.sessionId}`;
}

export function createLCodeDeferredDraftRegistry() {
  const sessionKeys = new Set<string>();

  return {
    remember(params: LCodeSessionWorkspaceTarget, snapshot: LCodeSessionStateSnapshot): void {
      sessionKeys.add(
        getSessionScopedKey({
          workspacePath: snapshot.session.workspace.workspacePath,
          workspaceIdentity:
            snapshot.session.workspace.workspaceIdentity ?? params.workspaceIdentity,
          sessionId: snapshot.session.sessionId,
        }),
      );
    },

    has(target: LCodeTaskTarget): boolean {
      return sessionKeys.has(getSessionScopedKey(target));
    },

    forget(target: LCodeTaskTarget): void {
      sessionKeys.delete(getSessionScopedKey(target));
    },
  };
}
