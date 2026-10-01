import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { WorkspaceShellSurface } from "./WorkspaceShellSurface.js";

// 接线护栏不是几何证据；GUI fixture 测生产 surface + Group + 面板的真实 rect/保活。
for (const isNarrowWebLayout of [true, false]) {
  test(`Web shell is not an implicit focus scroll owner (narrow=${isNarrowWebLayout})`, () => {
    const surface = WorkspaceShellSurface({ isNarrowWebLayout, isNativeDesktop: false });
    const utilities = surface.props.className.split(/\s+/u);
    assert.ok(
      utilities.includes("overflow-clip"),
      "Web chrome must not scroll when a toolbar descendant receives native focus",
    );
    assert.ok(
      !utilities.includes("overflow-hidden"),
      "hidden clips visually but is still a programmatic scroll container",
    );
    assert.equal(
      surface.props.onFocusCapture,
      undefined,
      "do not defeat Tab by restoring focus/scroll after the event",
    );
    assert.equal(
      surface.props.onKeyDownCapture,
      undefined,
      "native keyboard navigation stays intact",
    );
  });
}

test("native Desktop keeps its existing clipping while Web descendants retain their own scroll owners", async () => {
  const desktop = WorkspaceShellSurface({ isNarrowWebLayout: false, isNativeDesktop: true });
  assert.ok(desktop.props.className.split(/\s+/u).includes("overflow-hidden"));
  assert.ok(!desktop.props.className.split(/\s+/u).includes("overflow-clip"));
  const editor = await readFile(
    new URL("../prompt-editor/ChatPromptEditor.tsx", import.meta.url),
    "utf8",
  );
  assert.match(editor, /overflow-x-auto[^"\n]*[\s\S]*?data-composer-leading-actions/u);
  assert.match(editor, /data-composer-trailing-actions/u);
});

test("the persistent body group owns drawer geometry and does not clip it to conversation bounds", async () => {
  const source = await readFile(new URL("./WorkspaceShellSurface.tsx", import.meta.url), "utf8");
  assert.match(source, /data-workspace-body-group/u);
  assert.match(source, /!overflow-visible/u);
  assert.match(source, /onLayoutChange/u);
  assert.match(source, /persist.*Ref/u);
  const shell = await readFile(new URL("./WorkspaceShellLayout.tsx", import.meta.url), "utf8");
  assert.match(shell, /<WorkspaceShellSurface/u);
  assert.match(shell, /<WorkspaceBodyPanelGroup/u);
});

test("expanded panel size is observed while registered, never queried from layout-effect teardown", async () => {
  const hook = await readFile(new URL("./useAnimatedResizablePanel.ts", import.meta.url), "utf8");
  assert.doesNotMatch(hook, /useLayoutEffect/u);
  assert.match(hook, /onPanelResize/u);
  const shell = await readFile(new URL("./WorkspaceShellLayout.tsx", import.meta.url), "utf8");
  assert.match(shell, /onPanelResize=\{rememberSidePaneSize\}/u);
});

test("terminal auto focus checks touch and inert before invoking xterm focus", async () => {
  const source = await readFile(
    new URL("../terminal/TerminalSession.tsx", import.meta.url),
    "utf8",
  );
  const focus = source.slice(
    source.indexOf("const requestFocus"),
    source.indexOf("useEffect(() =>", source.indexOf("const requestFocus")),
  );
  assert.match(focus, /isCoarseTouchDevice\(\)/u);
  assert.match(focus, /closest\(['"]\[inert\]/u);
  assert.ok(focus.indexOf("isCoarseTouchDevice()") < focus.indexOf("term.focus()"));
});
