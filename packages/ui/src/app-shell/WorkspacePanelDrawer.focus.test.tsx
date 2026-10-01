import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as React from "react";
import { WorkspacePanelDrawer } from "./WorkspacePanelDrawer.js";

// 执行生产 Drawer 的 effect/键盘处理器，只检查 focus 策略；真实 rect/内部滚动另由 GUI 断言。
function mountDrawer(t: TestContext) {
  const listeners = new Map<string, EventListener>();
  const document = {
    activeElement: null as ElementStub | null,
    body: {} as unknown,
    overlays: [] as ElementStub[],
    querySelectorAll() {
      return document.overlays;
    },
    addEventListener(type: string, listener: EventListener) {
      listeners.set(type, listener);
    },
    removeEventListener(type: string) {
      listeners.delete(type);
    },
  };
  class ElementStub {
    ownerDocument = document;
    parentElement: ElementStub | null = null;
    isConnected = true;
    tabIndex = 0;
    dataset: Record<string, string> = {};
    children: ElementStub[] = [];
    focusCalls: Array<FocusOptions | undefined> = [];
    closest() {
      return null;
    }
    matches() {
      return false;
    }
    getClientRects() {
      return [1];
    }
    contains(target: unknown) {
      return target === this || this.children.includes(target as ElementStub);
    }
    querySelectorAll() {
      return this.children;
    }
    addEventListener() {}
    removeEventListener() {}
    focus(options?: FocusOptions) {
      this.focusCalls.push(options);
      document.activeElement = this;
    }
  }
  const oldGlobals = ["HTMLElement", "Node", "getComputedStyle"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: ElementStub });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: ElementStub });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: () => ({ visibility: "visible", opacity: "1" }),
  });

  const internals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const refs: Array<{ current: unknown }> = [];
  let effect: (() => void | (() => void)) | undefined;
  const previous = internals.H;
  internals.H = {
    useRef(value: unknown) {
      const ref = { current: value };
      refs.push(ref);
      return ref;
    },
    useLayoutEffect(callback: typeof effect) {
      effect = callback;
    },
  };
  const changes: boolean[] = [];
  const trigger = new ElementStub();
  try {
    WorkspacePanelDrawer({
      id: "drawer",
      enabled: true,
      open: true,
      label: "Navigation",
      closeLabel: "Close",
      onOpenChange: (open) => changes.push(open),
      triggerRef: { current: trigger as unknown as HTMLButtonElement },
      children: null,
    });
  } finally {
    internals.H = previous;
  }
  const panel = new ElementStub();
  const first = new ElementStub();
  const last = new ElementStub();
  panel.children = [first, last];
  refs[0]!.current = panel;
  refs[1]!.current = first;
  document.activeElement = trigger;
  const cleanup = effect?.();
  t.after(async () => {
    cleanup?.();
    await Promise.resolve();
    assert.equal(document.activeElement, trigger, "cleanup restores the non-editing trigger");
    assert.deepEqual(trigger.focusCalls, [{ preventScroll: true }]);
    for (const [key, descriptor] of oldGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return {
    document,
    panel,
    first,
    last,
    trigger,
    changes,
    key(key: string, shiftKey = false) {
      let prevented = false;
      let stopped = false;
      const event = {
        key,
        shiftKey,
        defaultPrevented: false,
        isComposing: false,
        preventDefault() {
          prevented = true;
        },
        stopPropagation() {
          stopped = true;
        },
      } as unknown as KeyboardEvent;
      listeners.get("keydown")?.(event);
      return { prevented, stopped };
    },
    overlay() {
      document.overlays = [new ElementStub()];
    },
  };
}

test("Shift+Tab from drawer close wraps to the last control with native scroll enabled", (t) => {
  const drawer = mountDrawer(t);
  assert.equal(drawer.document.activeElement, drawer.first);
  assert.deepEqual(
    drawer.first.focusCalls,
    [{ preventScroll: true }],
    "initial non-editing focus is unchanged",
  );
  assert.equal(drawer.key("Tab", true).prevented, true);
  assert.equal(drawer.document.activeElement, drawer.last);
  assert.deepEqual(
    drawer.last.focusCalls,
    [undefined],
    "wrapped target must be allowed to scroll into the drawer viewport",
  );
});

test("Tab from drawer last control wraps to close with native scroll enabled", (t) => {
  const drawer = mountDrawer(t);
  drawer.document.activeElement = drawer.last;
  assert.equal(drawer.key("Tab").prevented, true);
  assert.equal(drawer.document.activeElement, drawer.first);
  assert.deepEqual(drawer.first.focusCalls, [{ preventScroll: true }, undefined]);
});

test("nested overlays retain keyboard priority and drawer Escape stays a single close intent", (t) => {
  const drawer = mountDrawer(t);
  drawer.overlay();
  assert.equal(drawer.key("Tab", true).prevented, false);
  assert.equal(drawer.key("Escape").prevented, false);
  assert.deepEqual(drawer.changes, []);
  drawer.document.overlays = [];
  assert.deepEqual(drawer.key("Escape"), { prevented: true, stopped: true });
  assert.deepEqual(drawer.changes, [false]);
});
