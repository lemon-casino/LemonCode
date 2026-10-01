import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useNarrowWebLayout } from "./useNarrowWebLayout.js";

// 沿用 useGitBackupOnboarding.test.ts 的 dispatcher 测试方式；这里只驱动快照与订阅，不伪造 DOM 布局。
function readHook(isDesktop: boolean) {
  const internals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  let subscribe!: (onChange: () => void) => () => void;
  let getSnapshot!: () => boolean;
  const previous = internals.H;
  internals.H = {
    useMemo: (factory: () => unknown) => factory(),
    useCallback: (callback: unknown) => callback,
    useSyncExternalStore(nextSubscribe: typeof subscribe, nextSnapshot: typeof getSnapshot) {
      subscribe = nextSubscribe;
      getSnapshot = nextSnapshot;
      return getSnapshot();
    },
  };
  try {
    return { value: useNarrowWebLayout(isDesktop), subscribe, getSnapshot };
  } finally {
    internals.H = previous;
  }
}

function mockViewport(width: number) {
  const listeners = new Set<() => void>();
  const queries: string[] = [];
  let currentWidth = width;
  const media = {
    get matches() {
      return currentWidth < 768;
    },
    addEventListener: (event: string, listener: () => void) => {
      assert.equal(event, "change");
      listeners.add(listener);
    },
    removeEventListener: (event: string, listener: () => void) => {
      assert.equal(event, "change");
      listeners.delete(listener);
    },
  };
  return {
    queries,
    listeners,
    window: {
      matchMedia: (query: string) => {
        queries.push(query);
        assert.equal(query, "(width < 768px)");
        return media;
      },
    },
    resize(nextWidth: number) {
      const wasNarrow = currentWidth < 768;
      currentWidth = nextWidth;
      if (wasNarrow !== currentWidth < 768) {
        for (const listener of listeners) listener();
      }
    },
  };
}

for (const width of [320, 390, 767, 768, 844, 1280]) {
  test(`first Web snapshot at ${width}px uses the 768px boundary, without resize`, (t) => {
    const viewport = mockViewport(width);
    const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: viewport.window });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, "window", previous);
      else Reflect.deleteProperty(globalThis, "window");
    });
    assert.equal(readHook(false).value, width < 768);
    assert.equal(viewport.queries.length, 1);
  });
}

test("native Desktop never subscribes to the narrow Web policy", (t) => {
  const viewport = mockViewport(390);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: viewport.window });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const hook = readHook(true);
  assert.equal(hook.value, false);
  hook.subscribe(() => {})();
  assert.deepEqual(viewport.queries, []);
});

test("subscription emits breakpoint booleans and is removed on cleanup", (t) => {
  const viewport = mockViewport(767);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: viewport.window });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const hook = readHook(false);
  const snapshots: boolean[] = [];
  const unsubscribe = hook.subscribe(() => snapshots.push(hook.getSnapshot()));
  viewport.resize(500);
  viewport.resize(768);
  viewport.resize(1280);
  viewport.resize(767);
  assert.deepEqual(snapshots, [false, true]);
  unsubscribe();
  assert.equal(viewport.listeners.size, 0);
});

test("SSR and a missing matchMedia use the safe wide snapshot", () => {
  function Probe() {
    return React.createElement("span", null, String(useNarrowWebLayout(false)));
  }
  assert.equal(renderToStaticMarkup(React.createElement(Probe)), "<span>false</span>");
  assert.equal(readHook(false).value, false);
});
