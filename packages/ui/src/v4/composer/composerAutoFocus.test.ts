import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isCoarseTouchDevice } from "../../lib/pickerFocus.js";
import { resolveComposerAutoFocus } from "./composerAutoFocus.js";

const desktop = { autoFocusEnabled: true, disabled: false, isCoarseTouchDevice: false };

test("desktop keyboard keeps focus-now / defer / skip decisions", () => {
  assert.equal(resolveComposerAutoFocus(desktop), "focus-now");
  assert.equal(resolveComposerAutoFocus({ ...desktop, disabled: true }), "defer");
  assert.equal(resolveComposerAutoFocus({ ...desktop, autoFocusEnabled: false }), "skip");
  assert.equal(
    resolveComposerAutoFocus({ ...desktop, autoFocusEnabled: false, disabled: true }),
    "skip",
  );
});

test("coarse-touch auto focus is skipped rather than deferred across editable transitions", () => {
  for (const disabled of [true, false]) {
    assert.equal(
      resolveComposerAutoFocus({ ...desktop, disabled, isCoarseTouchDevice: true }),
      "skip",
    );
  }
});

test("a delayed focus must be skipped after the surface becomes inert or hidden", () => {
  assert.equal(resolveComposerAutoFocus({ ...desktop, isSurfaceHidden: true }), "skip");
  assert.equal(
    resolveComposerAutoFocus({ ...desktop, disabled: true, isSurfaceHidden: true }),
    "skip",
  );
  assert.equal(resolveComposerAutoFocus({ ...desktop, isSurfaceHidden: false }), "focus-now");
});

test("the existing coarse-touch detector is independent of portrait/landscape width", (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  for (const width of [390, 844, 1280]) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        innerWidth: width,
        matchMedia: (query: string) => ({
          matches: query === "(hover: none) and (pointer: coarse)",
        }),
      },
    });
    assert.equal(
      resolveComposerAutoFocus({ ...desktop, isCoarseTouchDevice: isCoarseTouchDevice() }),
      "skip",
    );
  }
});

test("ConversationComposer wires the shared pointer detector rather than a viewport constant", async () => {
  const source = await readFile(new URL("../ConversationComposer.tsx", import.meta.url), "utf8");
  assert.match(
    source,
    /import\s*\{\s*isCoarseTouchDevice\s*\}\s*from\s*"@\/lib\/pickerFocus\.js"/u,
  );
  const start = source.indexOf("const focusOptsRef");
  const end = source.indexOf("const handleCodeCommentRemoved", start);
  assert.ok(start > 0 && end > start);
  const focusWiring = source.slice(start, end);
  assert.match(focusWiring, /isCoarseTouchDevice:\s*isCoarseTouchDevice\(\)/u);
  assert.doesNotMatch(focusWiring, /isMobileViewport:\s*false/u);
  assert.match(focusWiring, /isSurfaceHidden/u);
  assert.match(focusWiring, /cancelAnimationFrame/u);
});
