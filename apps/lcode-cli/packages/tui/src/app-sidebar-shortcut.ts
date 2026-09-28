const SIDEBAR_LEADER_TIMEOUT_MS = 2_000;
export const SIDEBAR_LEADER_HINT = "Press B for sidebar, M for files, A for APIs.";
export const SIDEBAR_HIDDEN_STATUS = "Sidebar hidden.";
export const SIDEBAR_SHOWN_STATUS = "Sidebar shown.";
export const SIDEBAR_APIS_COLLAPSED_STATUS = "APIs collapsed.";
export const SIDEBAR_APIS_EXPANDED_STATUS = "APIs expanded.";
export const SIDEBAR_FILES_COLLAPSED_STATUS = "Modified files collapsed.";
export const SIDEBAR_FILES_EXPANDED_STATUS = "Modified files expanded.";

type SidebarShortcutKey = {
  ctrl?: boolean;
  meta?: boolean;
  name: string;
  option?: boolean;
  shift?: boolean;
};

export type SidebarShortcutState = {
  leaderArmedUntilMs?: number;
};

type SidebarShortcutIntent = "arm" | "pass" | "toggle-apis" | "toggle-files" | "toggle";

export function createSidebarShortcutState(): SidebarShortcutState {
  return {};
}

export function resolveSidebarShortcut(
  state: SidebarShortcutState,
  key: SidebarShortcutKey,
  nowMs: number,
  timeoutMs = SIDEBAR_LEADER_TIMEOUT_MS,
): SidebarShortcutIntent {
  const leaderActive =
    state.leaderArmedUntilMs !== undefined && nowMs <= state.leaderArmedUntilMs;

  if (leaderActive && isSidebarToggleKey(key)) {
    state.leaderArmedUntilMs = undefined;
    return "toggle";
  }
  if (leaderActive && isModifiedFilesToggleKey(key)) {
    state.leaderArmedUntilMs = undefined;
    return "toggle-files";
  }
  if (leaderActive && isApisToggleKey(key)) {
    state.leaderArmedUntilMs = undefined;
    return "toggle-apis";
  }

  if (isSidebarLeaderKey(key)) {
    state.leaderArmedUntilMs = nowMs + timeoutMs;
    return "arm";
  }

  state.leaderArmedUntilMs = undefined;
  return "pass";
}

function isSidebarLeaderKey(key: SidebarShortcutKey): boolean {
  return key.name.toLowerCase() === "x" && key.ctrl === true;
}

function isSidebarToggleKey(key: SidebarShortcutKey): boolean {
  return isPlainLeaderFollowupKey(key, "b");
}

function isModifiedFilesToggleKey(key: SidebarShortcutKey): boolean {
  return isPlainLeaderFollowupKey(key, "m");
}

function isApisToggleKey(key: SidebarShortcutKey): boolean {
  return isPlainLeaderFollowupKey(key, "a");
}

function isPlainLeaderFollowupKey(key: SidebarShortcutKey, name: string): boolean {
  return (
    key.name.toLowerCase() === name &&
    key.ctrl !== true &&
    key.meta !== true &&
    key.option !== true
  );
}
