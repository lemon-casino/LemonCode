import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspacePanelDrawer } from "./WorkspacePanelDrawer.js";
import { WorkspaceSidePaneToggleButton } from "@/WorkspaceSidePaneToggleButton.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import {
  readTaskSidePaneMemoryState,
  saveTaskSidePaneCollapsedPreference,
  saveTaskSidePaneMemoryState,
} from "@/lib/taskSidePaneMemory.js";
import { openCodeViewerSidePane } from "@/lib/workspaceSidePane.js";

// 只替换平台服务上下文；显隐、tabs、scope、内存偏好仍运行生产 useAppPanels。
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/hooks/useServices.tsx")) {
      return {
        format: "module",
        shortCircuit: true,
        source:
          "export const useServices = () => ({ lcodeAgentService: {}, lcodeSessionService: {} });",
      };
    }
    if (url.endsWith("/hooks/useInterfaceMode.ts")) {
      return {
        format: "module",
        shortCircuit: true,
        source: "export const useIsOfficeMode = () => false;",
      };
    }
    return nextLoad(url, context);
  },
});
const { useAppPanels } = await import("@/hooks/useAppPanels.js");

// 沿用 useGitBackupOnboarding.test.ts 的无 DOM dispatcher；断点/动作测试不冒充布局与焦点实测。
function mountPanels(initial: { narrow: boolean; key: string; desktop?: boolean }) {
  const internals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const slots: Array<{
    value?: unknown;
    deps?: readonly unknown[];
    cleanup?: () => void;
    set?: (value: unknown) => void;
  }> = [];
  let cursor = 0;
  let dirty = false;
  let effects: Array<() => void> = [];
  let options = {
    workspaceAbsPath: "/work/shared",
    workspaceIdentity: initial.key,
    workspaceRemoteSessionId: "fixture-remote",
    activeTaskId: "task-1",
    sidePaneOwnerId: "task-1",
    isDesktop: initial.desktop ?? false,
    isNarrowWebLayout: initial.narrow,
    defaultWhiteboardNamePrefix: "Board",
  };
  const next = () => slots[cursor++] ?? (slots[cursor - 1] = {});
  const changed = (before: readonly unknown[] | undefined, after: readonly unknown[]) =>
    !before ||
    before.length !== after.length ||
    before.some((value, index) => !Object.is(value, after[index]));
  const dispatcher = {
    useState(initialValue: unknown) {
      const slot = next();
      if (!("value" in slot))
        slot.value = typeof initialValue === "function" ? initialValue() : initialValue;
      slot.set ??= (value: unknown) => {
        const result = typeof value === "function" ? value(slot.value) : value;
        dirty ||= !Object.is(slot.value, result);
        slot.value = result;
      };
      return [slot.value, slot.set];
    },
    useRef(initialValue: unknown) {
      const slot = next();
      if (!("value" in slot)) slot.value = { current: initialValue };
      return slot.value;
    },
    useMemo(factory: () => unknown, deps: readonly unknown[]) {
      const slot = next();
      if (changed(slot.deps, deps)) {
        slot.value = factory();
        slot.deps = deps;
      }
      return slot.value;
    },
    useCallback(callback: unknown, deps: readonly unknown[]) {
      return dispatcher.useMemo(() => callback, deps);
    },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const slot = next();
      if (changed(slot.deps, deps)) {
        slot.deps = deps;
        effects.push(() => {
          slot.cleanup?.();
          slot.cleanup = effect() ?? undefined;
        });
      }
    },
    useLayoutEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      dispatcher.useEffect(effect, deps);
    },
  };
  const render = () => {
    cursor = 0;
    dirty = false;
    const previous = internals.H;
    internals.H = dispatcher;
    try {
      return useAppPanels(options);
    } finally {
      internals.H = previous;
    }
  };
  const settle = () => {
    let value = render();
    for (let index = 0; index < 12; index++) {
      const pending = effects;
      effects = [];
      for (const effect of pending) effect();
      if (!dirty && effects.length === 0) return value;
      value = render();
    }
    throw new Error("panel hook did not settle");
  };
  return {
    render,
    settle,
    setNarrow(narrow: boolean) {
      options = { ...options, isNarrowWebLayout: narrow };
      return settle();
    },
    setOwner(owner: string, beforeCommit?: () => void) {
      options = { ...options, activeTaskId: owner, sidePaneOwnerId: owner };
      beforeCommit?.();
      return settle();
    },
    setWorkspace(key: string) {
      options = { ...options, workspaceIdentity: key };
      return settle();
    },
    unmount() {
      for (const slot of slots) slot.cleanup?.();
    },
  };
}

function seedOpenPreview(key: string) {
  const opened = openCodeViewerSidePane(
    null,
    { type: "file", path: "/work/shared/example.ts", title: "example.ts" },
    "task-1",
  );
  const state = {
    ...opened,
    tabs: opened.tabs.map((tab) => ({ ...tab, ownerTaskId: "task-1", workspaceKey: key })),
  };
  saveTaskSidePaneMemoryState(key, { sidePaneState: state, isSidePaneCollapsed: false });
  saveTaskSidePaneCollapsedPreference(key, "task-1", false);
  return state;
}

test("first narrow Web render is single-column even with restored visible tabs", (t) => {
  const key = "mobile-panels:first";
  seedOpenPreview(key);
  const hook = mountPanels({ narrow: true, key });
  t.after(hook.unmount);
  const first = hook.render();
  assert.equal(first.isSidebarVisible, false);
  assert.equal(first.isSidePaneCollapsed, true);
  const settled = hook.settle();
  assert.equal(settled.isSidebarVisible, false);
  assert.equal(settled.isSidePaneCollapsed, true, "scope restoration must not reopen a drawer");
  assert.equal(settled.sidePaneState?.tabs.length, 1);
  assert.equal(readTaskSidePaneMemoryState(key).sidePaneCollapsedByOwner["task-1"], false);
});

test("narrow sidebar/detail intents are exclusive, closes are idempotent and tabs survive", (t) => {
  const hook = mountPanels({ narrow: true, key: "mobile-panels:exclusive" });
  t.after(hook.unmount);
  let state = hook.settle();
  state.handleToggleSidebar();
  state = hook.settle();
  assert.equal(state.isSidebarVisible, true);
  state.handleOpenCodeViewer({
    type: "file",
    path: "/work/shared/example.ts",
    title: "example.ts",
  });
  state = hook.settle();
  assert.equal(state.isSidePaneCollapsed, false);
  assert.equal(state.isSidebarVisible, false);
  const tab = state.sidePaneState?.tabs[0];
  state.handleCloseSidePane();
  state.handleCloseSidePane();
  state = hook.settle();
  assert.equal(state.isSidePaneCollapsed, true);
  assert.equal(state.sidePaneState?.tabs[0], tab);
  state.handleToggleSidePaneCollapse();
  state = hook.settle();
  assert.equal(state.isSidePaneCollapsed, false);
  state.handleToggleSidebar();
  state = hook.settle();
  assert.equal(state.isSidebarVisible, true);
  assert.equal(state.isSidePaneCollapsed, true);
  state.handleCloseSidebar();
  state.handleCloseSidebar();
  state = hook.settle();
  assert.equal(state.isSidebarVisible, false);
  assert.equal(state.sidePaneState?.tabs[0], tab);
});

test("breakpoint convergence is one-shot, preserves preferences, and does not reopen on exit", (t) => {
  const key = "mobile-panels:breakpoint";
  seedOpenPreview(key);
  const hook = mountPanels({ narrow: false, key });
  t.after(hook.unmount);
  let state = hook.settle();
  assert.equal(state.isSidebarVisible, true);
  assert.equal(state.isSidePaneCollapsed, false);
  const tabs = state.sidePaneState?.tabs;
  state = hook.setNarrow(true);
  assert.equal(state.isSidebarVisible, false);
  assert.equal(state.isSidePaneCollapsed, true);
  assert.equal(readTaskSidePaneMemoryState(key).sidePaneCollapsedByOwner["task-1"], false);
  state.handleToggleSidebar();
  state = hook.settle();
  assert.equal(
    hook.settle().isSidebarVisible,
    true,
    "an unchanged breakpoint cannot close a user-opened drawer",
  );
  state.handleCloseSidebar();
  state = hook.setNarrow(false);
  assert.equal(state.isSidebarVisible, false);
  assert.equal(state.isSidePaneCollapsed, true);
  assert.equal(state.sidePaneState?.tabs, tabs);
});

test("wide Desktop preserves independent panel intents and owner preferences", (t) => {
  const key = "mobile-panels:desktop";
  seedOpenPreview(key);
  const hook = mountPanels({ narrow: false, desktop: true, key });
  t.after(hook.unmount);
  let state = hook.settle();
  assert.equal(state.isSidebarVisible, true);
  assert.equal(state.isSidePaneCollapsed, false);
  state.handleToggleSidebar();
  state = hook.settle();
  assert.equal(state.isSidebarVisible, false);
  assert.equal(state.isSidePaneCollapsed, false);
  state.handleCloseSidePane();
  state = hook.settle();
  assert.equal(state.isSidePaneCollapsed, true);
  assert.equal(readTaskSidePaneMemoryState(key).sidePaneCollapsedByOwner["task-1"], true);
});

test("raw workflow reveal follows the same narrow mutual exclusion without adding a preference write", (t) => {
  const key = "mobile-panels:workflow";
  const hook = mountPanels({ narrow: true, key });
  t.after(hook.unmount);
  let state = hook.settle();
  state.handleToggleSidebar();
  state = hook.settle();
  state.handleOpenWorkflowRunDirectory({
    workspacePath: "/work/shared",
    workspaceIdentity: key,
    parentSessionId: "task-1",
  });
  state = hook.settle();
  assert.equal(state.isSidebarVisible, false);
  assert.equal(state.isSidePaneCollapsed, false);
  assert.equal(readTaskSidePaneMemoryState(key).sidePaneCollapsedByOwner["task-1"], undefined);
});

test("temporary narrow collapse is not saved by workspace switch or unmount", () => {
  const key = "mobile-panels:memory-a";
  const other = "mobile-panels:memory-b";
  seedOpenPreview(key);
  seedOpenPreview(other);
  const hook = mountPanels({ narrow: false, key });
  hook.settle();
  hook.setNarrow(true);
  const state = hook.setWorkspace(other);
  assert.equal(state.isSidePaneCollapsed, true);
  assert.equal(readTaskSidePaneMemoryState(key).isSidePaneCollapsed, false);
  assert.equal(readTaskSidePaneMemoryState(key).sidePaneCollapsedByOwner["task-1"], false);
  hook.unmount();
  assert.equal(readTaskSidePaneMemoryState(other).isSidePaneCollapsed, false);
});

test("same-commit navigation plus workflow reveal stays open for its explicit target", (t) => {
  const key = "mobile-panels:navigate-open";
  const hook = mountPanels({ narrow: true, key });
  t.after(hook.unmount);
  const state = hook.settle();
  state.handleOpenSidebar();
  const next = hook.setOwner("task-2", () => {
    state.handleOpenWorkflowRun({
      workspacePath: "/work/shared",
      workspaceIdentity: key,
      parentSessionId: "task-2",
      runId: "fixture-run",
      toolCallId: "fixture-tool",
    });
  });
  assert.equal(next.isSidebarVisible, false);
  assert.equal(next.isSidePaneCollapsed, false);
  assert.equal(next.sidePaneState?.tabs[0]?.type, "workflow-run");
});

test("owner restoration cannot reopen a manually closed narrow drawer", (t) => {
  const key = "mobile-panels:owner-restore";
  seedOpenPreview(key);
  const hook = mountPanels({ narrow: true, key });
  t.after(hook.unmount);
  let state = hook.settle();
  state.handleToggleSidePaneCollapse();
  state = hook.settle();
  state.handleCloseSidePane();
  hook.setOwner("task-2");
  state = hook.setOwner("task-1");
  assert.equal(state.isSidePaneCollapsed, true);
  assert.equal(state.sidePaneState?.tabs.length, 1);
});

test("drawer SSR retains content while closed and exposes a named modal only when enabled/open", () => {
  const render = (enabled: boolean, open: boolean) =>
    renderToStaticMarkup(
      <WorkspacePanelDrawer
        id="navigation"
        enabled={enabled}
        open={open}
        label="Workspace navigation"
        closeLabel="Close"
        onOpenChange={() => {}}
      >
        <input defaultValue="retained draft" />
      </WorkspacePanelDrawer>,
    );
  const hidden = render(true, false);
  assert.match(hidden, /inert=""/);
  assert.match(hidden, /value="retained draft"/);
  assert.doesNotMatch(hidden, /role="dialog"/);
  const open = render(true, true);
  assert.match(open, /role="dialog"/);
  assert.match(open, /aria-modal="true"/);
  assert.match(open, /aria-label="Workspace navigation"/);
  assert.match(open, /aria-label="Close"/);
  assert.doesNotMatch(open, /inert=""/);
  const wide = render(false, true);
  assert.doesNotMatch(wide, /role="dialog"/);
  assert.match(wide, /value="retained draft"/);
});

test("side-pane trigger keeps an explicit controlled expansion relationship", () => {
  const markup = renderToStaticMarkup(
    <LCodeIntlProvider initialLocale="en-US">
      <TooltipProvider>
        <WorkspaceSidePaneToggleButton
          isSidePaneOpen={false}
          ariaControls="details"
          onToggleSidePane={() => {}}
        />
      </TooltipProvider>
    </LCodeIntlProvider>,
  );
  assert.match(markup, /aria-expanded="false"/);
  assert.match(markup, /aria-controls="details"/);
  assert.match(markup, /aria-label="Expand side pane"/);
});
