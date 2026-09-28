import type { KeyEvent } from "@mbears/opentui-core";
import type { Dispatch, SetStateAction } from "react";
import type { SidebarSectionId } from "./app-sidebar-layout.js";
import {
  resolveSidebarShortcut,
  SIDEBAR_APIS_COLLAPSED_STATUS,
  SIDEBAR_APIS_EXPANDED_STATUS,
  SIDEBAR_FILES_COLLAPSED_STATUS,
  SIDEBAR_FILES_EXPANDED_STATUS,
  SIDEBAR_HIDDEN_STATUS,
  SIDEBAR_LEADER_HINT,
  SIDEBAR_SHOWN_STATUS,
  type SidebarShortcutState,
} from "./app-sidebar-shortcut.js";

export function handleSidebarShortcutKey(input: {
  consumeKey: (key: KeyEvent) => void;
  key: KeyEvent;
  nowMs: number;
  setStatus: Dispatch<SetStateAction<string>>;
  shortcutState: SidebarShortcutState;
  toggleSidebar: () => boolean;
  toggleSidebarSection: (section: SidebarSectionId) => boolean;
}): boolean {
  const sidebarIntent = resolveSidebarShortcut(input.shortcutState, input.key, input.nowMs);

  if (sidebarIntent === "arm") {
    input.consumeKey(input.key);
    input.setStatus(SIDEBAR_LEADER_HINT);
    return true;
  }
  if (sidebarIntent === "toggle") {
    input.consumeKey(input.key);
    input.setStatus(input.toggleSidebar() ? SIDEBAR_SHOWN_STATUS : SIDEBAR_HIDDEN_STATUS);
    return true;
  }
  if (sidebarIntent === "toggle-files") {
    input.consumeKey(input.key);
    input.setStatus(
      input.toggleSidebarSection("modifiedFiles")
        ? SIDEBAR_FILES_EXPANDED_STATUS
        : SIDEBAR_FILES_COLLAPSED_STATUS,
    );
    return true;
  }
  if (sidebarIntent === "toggle-apis") {
    input.consumeKey(input.key);
    input.setStatus(
      input.toggleSidebarSection("apis")
        ? SIDEBAR_APIS_EXPANDED_STATUS
        : SIDEBAR_APIS_COLLAPSED_STATUS,
    );
    return true;
  }

  return false;
}
