import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { SKIP_DOM_SELECTION_TAG } from "lexical";
import { PROGRAMMATIC_UPDATE_TAG } from "../lib/editorUpdateTags.js";

// 无 DOM 的决策回归；浏览器 fixture 另验真实 Lexical 选区与 activeElement。
const focus = await import("./editorFocus.js");
function root({ hidden = false, focused = false } = {}) {
  const element = {
    isConnected: true,
    parentElement: null,
    ownerDocument: {
      activeElement: null as unknown,
      defaultView: { getComputedStyle: () => ({ opacity: "1", visibility: "visible" }) },
    },
    closest: () => (hidden ? {} : null),
    getClientRects: () => [1],
    contains: (target: unknown) => target === element,
  };
  if (focused) element.ownerDocument.activeElement = element;
  return element as unknown as HTMLElement;
}

test("programmatic mobile restores keep the update tag but do not synchronize DOM selection", (t) => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "window");
  t.after(() => {
    if (before) Object.defineProperty(globalThis, "window", before);
    else Reflect.deleteProperty(globalThis, "window");
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { matchMedia: () => ({ matches: true }) },
  });
  assert.deepEqual(focus.getProgrammaticEditorUpdateTags({ getRootElement: () => root() }), [
    PROGRAMMATIC_UPDATE_TAG,
    SKIP_DOM_SELECTION_TAG,
  ]);
  assert.deepEqual(
    focus.getProgrammaticEditorUpdateTags({ getRootElement: () => root({ focused: true }) }),
    [PROGRAMMATIC_UPDATE_TAG],
  );
  assert.deepEqual(
    focus.getProgrammaticEditorUpdateTags({
      getRootElement: () => root({ hidden: true, focused: true }),
    }),
    [PROGRAMMATIC_UPDATE_TAG, SKIP_DOM_SELECTION_TAG],
  );
});

test("hidden or detached editor surfaces do not accept delayed focus", () => {
  assert.equal(focus.isEditorSurfaceHidden(null), true);
  assert.equal(focus.isEditorSurfaceHidden(root()), false);
  assert.equal(focus.isEditorSurfaceHidden(root({ hidden: true })), true);
});

test("Lexical restoration and the actual editable use the shared focus guard and compatibility token", async () => {
  const source = await readFile(new URL("../LexicalChatInput.tsx", import.meta.url), "utf8");
  assert.match(source, /getProgrammaticEditorUpdateTags/u);
  const programmaticTags = source.match(/tag:\s*getProgrammaticEditorUpdateTags\(editor\)/gu) ?? [];
  assert.ok(
    programmaticTags.length >= 9,
    "text, mention, plugin, skill, slash, append and state restore use the guard",
  );
  assert.match(source, /<ContentEditable[\s\S]*?className="[^"]*text-mobile-input-safe/u);
  assert.doesNotMatch(source, /focus:\s*\(\)\s*=>\s*editor\.focus\(\)/u);
});
