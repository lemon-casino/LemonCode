import { create } from "zustand";
import type { WorkspacePurpose } from "@lcode/shared";

const STORAGE_KEY = "lcode:remote-browser-navigation:v1";
const MAX_TARGETS = 20;
type NavigationStorage = Pick<Storage, "getItem" | "setItem">;

export interface RemoteBrowserNavigationTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  workspacePurpose?: WorkspacePurpose;
  localProjectId?: string;
  taskId: string | null;
}

interface NavigationMemory {
  hasEntered: boolean;
  targets: Record<string, RemoteBrowserNavigationTarget>;
}
interface NavigationStore extends NavigationMemory {
  enter(): void;
  remember(scope: string, target: RemoteBrowserNavigationTarget): void;
}

function browserStorage(): NavigationStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readMemory(storage: NavigationStorage | null): NavigationMemory {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(STORAGE_KEY) ?? null;
    if (raw === null) return { hasEntered: false, targets: {} };
    const parsed = JSON.parse(raw) as { targets?: unknown };
    const targets: Record<string, RemoteBrowserNavigationTarget> = {};
    if (parsed && typeof parsed.targets === "object" && parsed.targets !== null) {
      for (const [scope, value] of Object.entries(parsed.targets).slice(0, MAX_TARGETS)) {
        if (!scope.trim() || !value || typeof value !== "object") continue;
        const target = value as Record<string, unknown>;
        if (
          typeof target.workspacePath !== "string" ||
          !target.workspacePath.trim() ||
          (target.taskId !== null && (typeof target.taskId !== "string" || !target.taskId.trim()))
        )
          continue;
        targets[scope] = {
          workspacePath: target.workspacePath,
          taskId: target.taskId as string | null,
          ...Object.fromEntries(
            ["workspaceIdentity", "remoteSessionId", "localProjectId"].flatMap((key) =>
              typeof target[key] === "string" && target[key].trim()
                ? [[key, target[key].trim()]]
                : [],
            ),
          ),
          ...(target.workspacePurpose === "conversation" || target.workspacePurpose === "project"
            ? { workspacePurpose: target.workspacePurpose }
            : {}),
        };
      }
    }
    return { hasEntered: true, targets };
  } catch {
    // 已有记录表示浏览器用过；损坏的轻绑定不能把用户重新送回首次欢迎页。
    return { hasEntered: raw !== null, targets: {} };
  }
}

export function createRemoteBrowserNavigationStore(
  storage: NavigationStorage | null = browserStorage(),
) {
  function persist(memory: NavigationMemory) {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(memory));
    } catch {
      // 隐私模式/配额限制只影响跨页面记忆，不能中断当前页面的导航。
    }
  }
  return create<NavigationStore>()((set, get) => ({
    ...readMemory(storage),
    enter() {
      set({ hasEntered: true });
      const { hasEntered, targets } = get();
      persist({ hasEntered, targets });
    },
    remember(scope, target) {
      const targets = Object.fromEntries(
        [[scope, target], ...Object.entries(get().targets).filter(([key]) => key !== scope)].slice(
          0,
          MAX_TARGETS,
        ),
      );
      set({ hasEntered: true, targets });
      persist({ hasEntered: true, targets });
    },
  }));
}

export const useRemoteBrowserNavigationStore = createRemoteBrowserNavigationStore();
