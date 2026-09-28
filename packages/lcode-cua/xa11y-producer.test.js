/* eslint-disable max-lines -- 14 个方法共享一套 mock 图与 session owner，集中测试能显式证明覆盖完整词表。 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  XA11Y_PRODUCER_METHODS,
  Xa11yProducerError,
  createXa11yProducer,
} from "./xa11y-producer.js";

const context = (sessionId = "session-a") => ({ workspaceKey: "workspace", sessionId });
const appRef = (extra = {}) => ({ pid: 42, window_id: 7, ...extra });

class MockElement {
  constructor(input, log) {
    this.role = input.role;
    this.name = input.name ?? null;
    this.value = input.value ?? null;
    this.description = input.description ?? null;
    this.stableId = input.stableId ?? null;
    this.pid = input.pid ?? 42;
    this.actions = input.actions ?? [];
    this.bounds = input.bounds ?? null;
    this.raw = input.raw ?? {};
    this.enabled = input.enabled ?? true;
    this.visible = input.visible ?? true;
    this.focused = input.focused ?? false;
    this.active = input.active ?? false;
    this.checked = input.checked ?? null;
    this.selected = input.selected ?? false;
    this.expanded = input.expanded ?? null;
    this.editable = input.editable ?? false;
    this.focusable = input.focusable ?? true;
    this._children = input.children ?? [];
    this._log = log;
    this._staleAction = undefined;
  }

  async children() {
    return this._children;
  }

  async press() {
    if (this._staleAction === "press") throw namedError("SelectorNotMatchedError", "stale");
    this._log.push(["element.press", this.stableId]);
  }

  async focus() {
    this._log.push(["element.focus", this.stableId]);
  }

  async typeText(text) {
    this._log.push(["element.typeText", this.stableId, text]);
    this.value = `${this.value ?? ""}${text}`;
  }

  async setValue(value) {
    this._log.push(["element.setValue", this.stableId, value]);
    this.value = value;
  }

  async selectText(start, end) {
    this._log.push(["element.selectText", this.stableId, start, end]);
  }

  async performAction(action) {
    this._log.push(["element.performAction", this.stableId, action]);
  }
}

class MockApp {
  constructor(input) {
    this.name = input.name;
    this.pid = input.pid;
    this.isForeground = input.isForeground;
    this._root = input.root;
    this._windows = input.windows;
  }

  asElement() {
    return this._root;
  }

  async windows() {
    return this._windows;
  }
}

function namedError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

function createFixture() {
  const log = [];
  const label = new MockElement(
    { role: "text", name: "Submit label", stableId: "label", focusable: false },
    log,
  );
  const button = new MockElement(
    {
      role: "button",
      name: "Submit",
      stableId: "button",
      actions: ["show_menu", "press"],
      bounds: { x: 20, y: 20, width: 60, height: 30 },
      children: [label],
    },
    log,
  );
  const field = new MockElement(
    {
      role: "text_field",
      name: "Query",
      value: "abcd",
      stableId: "field",
      actions: ["set_value", "select_text"],
      editable: true,
      focused: true,
      bounds: { x: 20, y: 60, width: 120, height: 30 },
    },
    log,
  );
  const scroller = new MockElement(
    {
      role: "scroll_area",
      name: "Results",
      stableId: "scroller",
      actions: ["scroll_down"],
      bounds: { x: 0, y: 100, width: 200, height: 100 },
    },
    log,
  );
  const window = new MockElement(
    {
      role: "window",
      name: "Notes",
      stableId: "7",
      active: true,
      raw: { window_id: 7, main: true, subrole: "standard_window" },
      bounds: { x: 10, y: 20, width: 200, height: 100 },
      children: [button, field, scroller],
    },
    log,
  );
  const root = new MockElement(
    {
      role: "application",
      name: "Notes",
      stableId: "app-42",
      raw: { bundle_id: "com.example.notes" },
      children: [window],
    },
    log,
  );
  const app = new MockApp({ name: "Notes", pid: 42, isForeground: true, root, windows: [window] });
  const input = {
    async click(target, options) {
      log.push(["input.click", target, options]);
    },
    async moveTo(target) {
      log.push(["input.moveTo", target]);
    },
    async drag(from, to, options) {
      log.push(["input.drag", from, to, options]);
    },
    async mouseDown(button) {
      log.push(["input.mouseDown", button]);
    },
    async mouseUp(button) {
      log.push(["input.mouseUp", button]);
    },
    async scroll(target, dx, dy) {
      log.push(["input.scroll", target, dx, dy]);
    },
    async press(key) {
      log.push(["input.press", key]);
    },
    async chord(key, held) {
      log.push(["input.chord", key, held]);
    },
    async keyDown(key) {
      log.push(["input.keyDown", key]);
    },
    async keyUp(key) {
      log.push(["input.keyUp", key]);
    },
    async typeText(text) {
      log.push(["input.typeText", text]);
    },
  };
  const fixture = {
    apps: [app],
    app,
    root,
    window,
    button,
    field,
    scroller,
    input,
    log,
    screenshotFails: false,
    loadCount: 0,
    pasteCalls: [],
    accessCalls: [],
    stopCalls: [],
    ids: 0,
  };
  fixture.module = {
    App: {
      async list() {
        return fixture.apps;
      },
    },
    inputSim() {
      return input;
    },
    async screenshot({ element }) {
      assert.equal(element, fixture.window);
      if (fixture.screenshotFails) throw namedError("PlatformError", "capture failed");
      return {
        width: 200,
        height: 100,
        mappingAvailable: true,
        imageToDesktop(x, y) {
          return [x + 10, y + 20];
        },
        toPng() {
          return Buffer.from("mock-png");
        },
      };
    },
  };
  fixture.createProducer = (overrides = {}) =>
    createXa11yProducer({
      async loadXa11y() {
        fixture.loadCount += 1;
        return fixture.module;
      },
      randomUUID() {
        fixture.ids += 1;
        return `id-${fixture.ids}`;
      },
      async requestAccess(inputValue) {
        fixture.accessCalls.push(inputValue);
        return { ready: true, accessibility: "granted", screenRecording: "granted" };
      },
      async paste(inputValue) {
        fixture.pasteCalls.push(inputValue);
      },
      async stop(inputValue) {
        fixture.stopCalls.push(inputValue);
      },
      async delay(milliseconds) {
        fixture.log.push(["delay", milliseconds]);
      },
      ...overrides,
    });
  return fixture;
}

async function observe(producer, sessionId = "session-a", overrides = {}) {
  return producer.dispatch(
    "get_app_state",
    { app_ref: appRef(), disable_diffing: true, ...overrides },
    context(sessionId),
  );
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof Xa11yProducerError);
    assert.equal(error.code, code);
    return true;
  });
}

test("exports the complete 0.1.0 method vocabulary", () => {
  assert.deepEqual(XA11Y_PRODUCER_METHODS, [
    "list_apps",
    "list_windows",
    "get_app_state",
    "left_click",
    "left_click_drag",
    "scroll",
    "type",
    "set_value",
    "select_text",
    "key",
    "paste",
    "perform_action",
    "request_access",
    "stop_computer_control",
  ]);
});

test("validates before lazy native import and resolves AppRef strictly", async () => {
  const fixture = createFixture();
  const producer = fixture.createProducer();

  await expectCode(
    producer.dispatch("list_apps", { unexpected: true }, context()),
    "INVALID_REQUEST",
  );
  assert.equal(fixture.loadCount, 0);
  assert.deepEqual(await producer.dispatch("list_apps", {}, context()), [
    { pid: 42, name: "Notes", bundle_id: "com.example.notes", active: true },
  ]);
  assert.equal(fixture.loadCount, 1);

  const duplicateRoot = new MockElement(
    { role: "application", raw: { bundle_id: "com.example.other" } },
    fixture.log,
  );
  const duplicateWindow = new MockElement(
    {
      role: "window",
      name: "Other Notes",
      stableId: "9",
      raw: { window_id: 9 },
      bounds: { x: 0, y: 0, width: 100, height: 100 },
    },
    fixture.log,
  );
  fixture.apps.push(
    new MockApp({
      name: "Notes",
      pid: 99,
      isForeground: false,
      root: duplicateRoot,
      windows: [duplicateWindow],
    }),
  );
  await expectCode(
    producer.dispatch("list_windows", { app_ref: { name: "Notes" } }, context()),
    "AMBIGUOUS_APP",
  );
  assert.equal(
    (
      await producer.dispatch(
        "list_windows",
        { app_ref: { bundle_id: "com.example.notes" } },
        context(),
      )
    )[0].window_id,
    7,
  );
  await expectCode(
    producer.dispatch("list_windows", { app_ref: { window_id: 7 } }, context()),
    "INVALID_APP",
  );
});

test("get_app_state launches a missing installed app once and merges concurrent callers", async () => {
  const fixture = createFixture();
  fixture.apps = [];
  let releaseLaunch;
  const launchCalls = [];
  const launcher = {
    async launch(ref) {
      launchCalls.push(ref);
      await new Promise((resolve) => {
        releaseLaunch = resolve;
      });
      fixture.apps = [fixture.app];
    },
    async dispose() {},
  };
  const producer = fixture.createProducer({ launcher, launchPollAttempts: 2 });
  const first = producer.dispatch(
    "get_app_state",
    { app_ref: { name: "Notes" }, disable_diffing: true },
    context("launch-a"),
  );
  const second = producer.dispatch(
    "get_app_state",
    { app_ref: { name: " Notes " }, disable_diffing: true },
    context("launch-b"),
  );
  while (!releaseLaunch) await new Promise((resolve) => setImmediate(resolve));
  releaseLaunch();

  const states = await Promise.all([first, second]);
  assert.equal(launchCalls.length, 1);
  assert.deepEqual(launchCalls[0], { name: "Notes" });
  assert.deepEqual(
    states.map((state) => state.app.pid),
    [42, 42],
  );
});

test("launch readiness uses the selected installed identity instead of the raw lookup text", async () => {
  const fixture = createFixture();
  fixture.apps = [];
  fixture.app.name = "QQ";
  const producer = fixture.createProducer({
    launcher: {
      async launch() {
        fixture.apps = [fixture.app];
        return {
          name: "QQScLauncher",
          appId: "Tencent.QQScLauncher_abc!QQScLauncher",
        };
      },
      async dispose() {},
    },
    launchPollAttempts: 2,
  });

  const state = await producer.dispatch(
    "get_app_state",
    { app_ref: { name: "qq launcher" }, disable_diffing: true },
    context(),
  );
  assert.equal(state.app.name, "QQ");
});

test("launch readiness treats Linux desktop ids with or without the suffix as equal", async () => {
  const fixture = createFixture();
  fixture.apps = [];
  fixture.app.name = "Runtime Process";
  fixture.root.raw.bundle_id = "org.example.App";
  const producer = fixture.createProducer({
    platform: "linux",
    launcher: {
      async launch() {
        fixture.apps = [fixture.app];
        return {
          name: "Desktop Entry",
          desktopId: "org.example.App.desktop",
          executable: "example-app",
        };
      },
      async dispose() {},
    },
    launchPollAttempts: 2,
  });

  const state = await producer.dispatch(
    "get_app_state",
    { app_ref: { bundle_id: "org.example.App.desktop" }, disable_diffing: true },
    context(),
  );
  assert.equal(state.app.bundle_id, "org.example.App");
});

test("an already-running normalized Windows app is reused without launching it again", async () => {
  const fixture = createFixture();
  fixture.app.name = "QQLauncher";
  let launchCount = 0;
  const producer = fixture.createProducer({
    platform: "win32",
    launcher: {
      async launch() {
        launchCount += 1;
      },
      async dispose() {},
    },
  });

  const state = await producer.dispatch(
    "get_app_state",
    { app_ref: { name: "QQ" }, disable_diffing: true },
    context(),
  );
  assert.equal(state.app.name, "QQLauncher");
  assert.equal(launchCount, 0);
});

test("a localized Windows app name reuses the matching running executable identity", async () => {
  const fixture = createFixture();
  fixture.app.name = "Weixin";
  let launchCount = 0;
  const producer = fixture.createProducer({
    platform: "win32",
    launcher: {
      async resolve() {
        return { name: "Weixin", appId: "D:\\Tencent\\Weixin\\Weixin.exe" };
      },
      async launch() {
        launchCount += 1;
      },
      async dispose() {},
    },
  });

  const state = await producer.dispatch(
    "get_app_state",
    { app_ref: { name: "微信" }, disable_diffing: true },
    context(),
  );
  assert.equal(state.app.name, "Weixin");
  assert.equal(launchCount, 0);
});

test("a localized Windows name can bind through a unique live window title", async () => {
  const fixture = createFixture();
  fixture.app.name = "Weixin";
  fixture.window.name = "微信";
  let launchCount = 0;
  const producer = fixture.createProducer({
    platform: "win32",
    launcher: {
      async launch() {
        launchCount += 1;
      },
      async dispose() {},
    },
  });

  const state = await producer.dispatch(
    "get_app_state",
    { app_ref: { name: "微信" }, disable_diffing: true },
    context(),
  );
  assert.equal(state.app.name, "Weixin");
  assert.equal(state.window.title, "微信");
  assert.equal(launchCount, 0);
});

test("a localized title selects the intended window when a custom app exposes siblings", async () => {
  const fixture = createFixture();
  fixture.app.name = "Weixin";
  fixture.window.name = "微信";
  fixture.window.stableId = "hwnd:0x2a";
  delete fixture.window.raw.window_id;
  const mediaWindow = new MockElement(
    {
      role: "window",
      name: "图片和视频",
      stableId: "hwnd:0x2b",
      focused: true,
      children: [],
      raw: {},
    },
    fixture.log,
  );
  fixture.app._windows = [fixture.window, mediaWindow];
  const producer = fixture.createProducer({
    platform: "win32",
    launcher: {
      async launch() {
        throw new Error("title match should avoid launch");
      },
      async dispose() {},
    },
  });

  const state = await producer.dispatch(
    "get_app_state",
    { app_ref: { name: "微信" }, disable_diffing: true },
    context(),
  );
  assert.equal(state.window.title, "微信");
  assert.equal(state.window.window_id, 42);
});

test("launch readiness rejects ambiguous normalized live app identities", async () => {
  const fixture = createFixture();
  fixture.apps = [];
  fixture.app.name = "QQ";
  const duplicate = new MockApp({
    name: "QQLauncher",
    pid: 43,
    isForeground: false,
    root: fixture.root,
    windows: [fixture.window],
  });
  const producer = fixture.createProducer({
    launcher: {
      async launch() {
        fixture.apps = [fixture.app, duplicate];
        return { name: "QQScLauncher" };
      },
      async dispose() {},
    },
    launchPollAttempts: 2,
  });

  await expectCode(
    producer.dispatch(
      "get_app_state",
      { app_ref: { name: "qq launcher" }, disable_diffing: true },
      context(),
    ),
    "AMBIGUOUS_APP",
  );
});

test("launch readiness waits for a uniquely selectable window after the process appears", async () => {
  const fixture = createFixture();
  fixture.apps = [];
  fixture.app._windows = [];
  let delayCount = 0;
  const producer = fixture.createProducer({
    launcher: {
      async launch() {
        fixture.apps = [fixture.app];
        return { name: "Notes" };
      },
      async dispose() {},
    },
    launchPollAttempts: 3,
    async delay(milliseconds) {
      fixture.log.push(["delay", milliseconds]);
      delayCount += 1;
      if (delayCount === 1) fixture.app._windows = [fixture.window];
    },
  });

  const state = await producer.dispatch(
    "get_app_state",
    { app_ref: { name: "Notes" }, disable_diffing: true },
    context(),
  );
  assert.equal(state.window.window_id, 7);
  assert.equal(delayCount, 1);
});

test("only the initial get_app_state lookup may launch", async () => {
  const fixture = createFixture();
  fixture.apps = [];
  let launchCount = 0;
  const producer = fixture.createProducer({
    launcher: {
      async launch() {
        launchCount += 1;
      },
      async dispose() {},
    },
    launchPollAttempts: 1,
  });

  await expectCode(
    producer.dispatch("list_windows", { app_ref: { name: "Notes" } }, context()),
    "APP_NOT_FOUND",
  );
  await expectCode(
    producer.dispatch("get_app_state", { app_ref: { pid: 42 }, disable_diffing: true }, context()),
    "APP_NOT_FOUND",
  );
  assert.equal(launchCount, 0);
});

test("launch timeout is bounded, reported as APP_NOT_READY and does not poison later attempts", async () => {
  const fixture = createFixture();
  fixture.apps = [];
  let launchCount = 0;
  const producer = fixture.createProducer({
    launcher: {
      async launch() {
        launchCount += 1;
      },
      async dispose() {},
    },
    launchPollAttempts: 2,
    launchPollIntervalMs: 5,
  });
  const input = {
    app_ref: { bundle_id: "com.example.notes" },
    disable_diffing: true,
  };

  await expectCode(producer.dispatch("get_app_state", input, context()), "APP_NOT_READY");
  await expectCode(producer.dispatch("get_app_state", input, context()), "APP_NOT_READY");
  assert.equal(launchCount, 2);
  assert.deepEqual(
    fixture.log.filter(([name]) => name === "delay"),
    [
      ["delay", 5],
      ["delay", 5],
    ],
  );
});

test("dispose aborts an in-flight launch poll and disposes the launcher", async () => {
  const fixture = createFixture();
  fixture.apps = [];
  let disposeCount = 0;
  let polling;
  const producer = fixture.createProducer({
    launcher: {
      async launch() {},
      async dispose() {
        disposeCount += 1;
      },
    },
    launchPollAttempts: 20,
    delay() {
      polling = true;
      return new Promise(() => {});
    },
  });
  const pending = producer.dispatch(
    "get_app_state",
    { app_ref: { name: "Notes" }, disable_diffing: true },
    context(),
  );
  while (!polling) await new Promise((resolve) => setImmediate(resolve));
  await producer.dispose();

  await expectCode(pending, "CONTROL_STOPPED");
  assert.equal(disposeCount, 1);
});

test("dispose fences an in-flight application enumeration", async () => {
  const fixture = createFixture();
  let releaseList;
  let markListStarted;
  const listStarted = new Promise((resolve) => {
    markListStarted = resolve;
  });
  fixture.module.App.list = async () => {
    markListStarted();
    return await new Promise((resolve) => {
      releaseList = () => resolve([fixture.app]);
    });
  };
  const producer = fixture.createProducer();
  const pending = producer.dispatch(
    "get_app_state",
    { app_ref: appRef(), disable_diffing: true },
    context(),
  );
  await listStarted;
  await producer.dispose();
  releaseList();

  await expectCode(pending, "CONTROL_STOPPED");
});

test("lists real window fields and returns deterministic state plus mapped PNG frame", async () => {
  const fixture = createFixture();
  const producer = fixture.createProducer();

  assert.deepEqual(await producer.dispatch("list_windows", { app_ref: { pid: 42 } }, context()), [
    {
      index: 0,
      window_id: 7,
      title: "Notes",
      bounds: [10, 20, 200, 100],
      main: true,
      focused: true,
      onscreen: true,
      subrole: "standard_window",
    },
  ]);
  const state = await observe(producer, "session-a", { include_screenshot: true });
  assert.equal(state.mode, "full");
  assert.deepEqual(
    state.elements.map(({ index, role, parent_index }) => ({ index, role, parent_index })),
    [
      { index: 0, role: "window", parent_index: null },
      { index: 1, role: "button", parent_index: 0 },
      { index: 2, role: "text", parent_index: 1 },
      { index: 3, role: "text_field", parent_index: 0 },
      { index: 4, role: "scroll_area", parent_index: 0 },
    ],
  );
  assert.equal(state.screenshot.data, Buffer.from("mock-png").toString("base64"));
  assert.equal(state.screenshot.mime_type, "image/png");
  assert.equal(state.frame_id, state.screenshot.frame_id);
  assert.match(state.text, /^state_id: /u);

  await producer.dispatch(
    "left_click",
    {
      target: { type: "coordinate", x: 5, y: 6, frame_id: state.frame_id },
      app_ref: appRef(),
      strategy: "event",
    },
    context(),
  );
  const rawClick = fixture.log.find(([name]) => name === "input.click");
  assert.deepEqual(rawClick[1], [15, 26]);
});

test("screenshot failure preserves the accessibility tree and clears coordinate actionability", async () => {
  const fixture = createFixture();
  const producer = fixture.createProducer();
  await observe(producer, "session-a", { include_screenshot: true });
  fixture.screenshotFails = true;
  const state = await observe(producer, "session-a", { include_screenshot: true });
  assert.equal(state.elements.length, 5);
  assert.equal(state.screenshot, undefined);
  assert.match(state.non_actionable_reason, /^screenshot_unavailable:/u);
  await expectCode(
    producer.dispatch(
      "left_click",
      { target: [1, 1], app_ref: appRef(), strategy: "event" },
      context(),
    ),
    "STALE_STATE",
  );
});

test("keeps an actionable screenshot when a custom surface cannot expose its child tree", async () => {
  const fixture = createFixture();
  const producer = fixture.createProducer();
  fixture.window.children = async () => {
    throw new Error("custom renderer has no UIA child projection");
  };

  const degraded = await observe(producer, "session-a", { include_screenshot: true });
  assert.equal(degraded.elements.length, 1);
  assert.equal(degraded.tree_unavailable_reason, "accessibility_tree_unavailable");
  assert.equal(degraded.screenshot.mime_type, "image/png");
  assert.match(degraded.text, /tree_unavailable_reason: accessibility_tree_unavailable/u);

  await producer.dispatch(
    "left_click",
    {
      target: { type: "coordinate", x: 5, y: 6, frame_id: degraded.frame_id },
      app_ref: appRef(),
      strategy: "event",
    },
    context(),
  );
  assert.ok(fixture.log.some(([name]) => name === "input.click"));
  await expectCode(
    producer.dispatch("left_click", { target: 1, app_ref: appRef(), strategy: "a11y" }, context()),
    "ELEMENT_UNAVAILABLE",
  );

  await expectCode(
    producer.dispatch(
      "get_app_state",
      { app_ref: appRef(), disable_diffing: true },
      context("session-tree-only"),
    ),
    "STRUCTURED_STATE_UNAVAILABLE",
  );

  fixture.window.children = async () => fixture.window._children;
  const healthy = await producer.dispatch(
    "get_app_state",
    { app_ref: appRef(), tree_shown_to_model: true },
    context(),
  );
  assert.equal(healthy.mode, "full");
});

test("does not downgrade a broken tree without an actionable screenshot mapping", async () => {
  const fixture = createFixture();
  fixture.window.children = async () => {
    throw new Error("custom renderer has no UIA child projection");
  };
  fixture.module.screenshot = async () => ({
    width: 200,
    height: 100,
    mappingAvailable: false,
    toPng() {
      return Buffer.from("mock-png");
    },
  });
  const producer = fixture.createProducer();

  await expectCode(
    producer.dispatch(
      "get_app_state",
      { app_ref: appRef(), include_screenshot: true, disable_diffing: true },
      context(),
    ),
    "STRUCTURED_STATE_UNAVAILABLE",
  );
});

test("returns null instead of fabricating a window id and refuses unverifiable handles", async () => {
  const fixture = createFixture();
  fixture.window.stableId = null;
  delete fixture.window.raw.window_id;
  const producer = fixture.createProducer();
  const state = await producer.dispatch(
    "get_app_state",
    { app_ref: { pid: 42 }, disable_diffing: true },
    context(),
  );
  assert.equal(state.window.window_id, null);
  assert.equal(state.elements.length, 5);
  await expectCode(
    producer.dispatch("left_click", { target: 1, app_ref: { pid: 42 } }, context()),
    "STALE_STATE",
  );
});

test("projects a native HWND encoded in xa11y stableId", async () => {
  const fixture = createFixture();
  fixture.window.stableId = "hwnd:0x2a";
  delete fixture.window.raw.window_id;
  const producer = fixture.createProducer();

  const state = await producer.dispatch(
    "get_app_state",
    { app_ref: { pid: 42 }, disable_diffing: true },
    context(),
  );
  assert.equal(state.window.window_id, 42);
  await producer.dispatch(
    "left_click",
    { target: 1, app_ref: { pid: 42, window_id: 42 } },
    context(),
  );
});

test("dispatches semantic element actions without replaying them as input events", async () => {
  const fixture = createFixture();
  const producer = fixture.createProducer();
  await observe(producer, "session-a", { include_screenshot: true });

  await producer.dispatch("left_click", { target: 1, app_ref: appRef() }, context());
  await producer.dispatch(
    "scroll",
    { target: 4, scroll_direction: "down", scroll_amount: 2, app_ref: appRef() },
    context(),
  );
  await producer.dispatch("type", { target: 3, text: "!", app_ref: appRef() }, context());
  await producer.dispatch(
    "set_value",
    { target: 3, value: "updated", app_ref: appRef(), return_state: "full" },
    context(),
  );
  await producer.dispatch(
    "select_text",
    { target: 3, text_range: [1, 2], app_ref: appRef() },
    context(),
  );
  await producer.dispatch(
    "perform_action",
    { target: 1, action: "show_menu", app_ref: appRef() },
    context(),
  );

  assert.deepEqual(
    fixture.log.filter(([name]) => name.startsWith("element.")),
    [
      ["element.press", "button"],
      ["element.performAction", "scroller", "scroll_down"],
      ["element.performAction", "scroller", "scroll_down"],
      ["element.typeText", "field", "!"],
      ["element.setValue", "field", "updated"],
      ["element.selectText", "field", 1, 3],
      ["element.performAction", "button", "show_menu"],
    ],
  );
  assert.equal(
    fixture.log.some(([name]) => name.startsWith("input.")),
    false,
  );
});

test("uses xa11y inputSim for drag, raw click, key and event typing", async () => {
  const fixture = createFixture();
  const producer = fixture.createProducer();
  await observe(producer, "session-a", { include_screenshot: true });

  await producer.dispatch(
    "left_click",
    {
      target: 1,
      mouse_button: "right",
      click_count: 2,
      modifiers: "shift",
      strategy: "event",
      app_ref: appRef(),
    },
    context(),
  );
  await producer.dispatch(
    "left_click_drag",
    { from_target: 1, to: 3, modifiers: "ctrl", app_ref: appRef() },
    context(),
  );
  await producer.dispatch(
    "type",
    { target: [5, 6], text: "raw", strategy: "event", app_ref: appRef() },
    context(),
  );
  await producer.dispatch("key", { text: "ctrl+a", repeat: 2, app_ref: appRef() }, context());

  assert.deepEqual(
    fixture.log.find(([name]) => name === "input.click"),
    ["input.click", fixture.button, { button: "right", count: 2, held: ["Shift"] }],
  );
  assert.deepEqual(
    fixture.log.find(([name]) => name === "input.drag"),
    ["input.drag", fixture.button, fixture.field, { held: ["Ctrl"] }],
  );
  assert.ok(fixture.log.some((entry) => entry[0] === "input.click" && entry[1][0] === 15));
  assert.ok(fixture.log.some((entry) => entry[0] === "input.typeText" && entry[1] === "raw"));
  assert.equal(fixture.log.filter(([name]) => name === "input.chord").length, 2);
});

test("smooth motion profile drives bounded paths between known coordinate targets", async () => {
  const fixture = createFixture();
  const producer = fixture.createProducer({
    motionProfile: "smooth",
    motionDurationMs: 40,
    motionSegmentPixels: 20,
    motionMaxSegments: 8,
  });
  await observe(producer, "session-a", { include_screenshot: true });

  await producer.dispatch(
    "left_click",
    { target: [10, 10], strategy: "event", app_ref: appRef() },
    context(),
  );
  assert.equal(
    fixture.log.some(([name]) => name === "input.moveTo"),
    false,
  );

  await producer.dispatch(
    "left_click",
    { target: [190, 80], strategy: "event", app_ref: appRef() },
    context(),
  );
  const moves = fixture.log.filter(([name]) => name === "input.moveTo");
  assert.ok(moves.length >= 2 && moves.length <= 8);
  assert.deepEqual(moves.at(-1), ["input.moveTo", [200, 100]]);
  assert.equal(fixture.log.filter(([name]) => name === "delay").length, moves.length - 1);
});

test("smooth coordinate drag releases mouse and modifiers when motion fails", async () => {
  const fixture = createFixture();
  const producer = fixture.createProducer({
    motionProfile: "smooth",
    motionDurationMs: 40,
    motionSegmentPixels: 20,
    motionMaxSegments: 8,
  });
  await observe(producer, "session-a", { include_screenshot: true });
  fixture.input.moveTo = async (target) => {
    fixture.log.push(["input.moveTo", target]);
    if (target[0] > 10) throw namedError("PlatformError", "move failed");
  };

  await assert.rejects(
    producer.dispatch(
      "left_click_drag",
      { from_target: [0, 0], to: [190, 80], modifiers: "ctrl", app_ref: appRef() },
      context(),
    ),
    (error) => error?.code === "INTERNAL",
  );

  assert.equal(
    fixture.log.some(([name]) => name === "input.drag"),
    false,
  );
  assert.ok(fixture.log.some(([name]) => name === "input.mouseDown"));
  assert.ok(fixture.log.some(([name]) => name === "input.mouseUp"));
  assert.ok(fixture.log.some(([name]) => name === "input.keyDown"));
  assert.ok(fixture.log.some(([name]) => name === "input.keyUp"));
});

test("rejects an unknown motion profile before loading xa11y", () => {
  const fixture = createFixture();
  assert.throws(
    () => fixture.createProducer({ motionProfile: "human-ish" }),
    (error) => error?.code === "INVALID_REQUEST",
  );
  assert.equal(fixture.loadCount, 0);
});

test("releases pressed modifiers when a held key chord fails midway", async () => {
  const fixture = createFixture();
  const producer = fixture.createProducer();
  fixture.input.keyDown = async (key) => {
    fixture.log.push(["input.keyDown", key]);
    if (key === "a") throw namedError("PlatformError", "key down failed");
  };

  await assert.rejects(
    producer.dispatch("key", { text: "ctrl+a", hold_seconds: 0.1, app_ref: appRef() }, context()),
    (error) => {
      assert.equal(error.code, "INTERNAL");
      assert.equal(error.actionSent, true);
      return true;
    },
  );
  assert.deepEqual(
    fixture.log.filter(([name]) => name === "input.keyDown" || name === "input.keyUp"),
    [
      ["input.keyDown", "Ctrl"],
      ["input.keyDown", "a"],
      ["input.keyUp", "Ctrl"],
    ],
  );
});

test("injects clipboard, access and stop seams without inventing xa11y APIs", async () => {
  const fixture = createFixture();
  const producer = fixture.createProducer();

  assert.deepEqual(
    await producer.dispatch("request_access", { capabilities: ["accessibility"] }, context()),
    { ready: true, accessibility: "granted", screenRecording: "granted" },
  );
  assert.equal(fixture.loadCount, 0);
  await observe(producer);
  await producer.dispatch("paste", { text: "hello", format: "md", app_ref: appRef() }, context());
  assert.equal(fixture.pasteCalls[0].text, "hello");
  assert.equal(fixture.pasteCalls[0].format, "md");

  assert.deepEqual(
    await producer.dispatch("stop_computer_control", { reason: "done" }, context()),
    { stopped: true },
  );
  assert.equal(fixture.stopCalls[0].reason, "done");
  await expectCode(
    producer.dispatch("left_click", { target: 1, app_ref: appRef() }, context()),
    "ELEMENT_UNAVAILABLE",
  );
});

test("keeps snapshots session-scoped and fails closed for stale windows and elements", async () => {
  const fixture = createFixture();
  const producer = fixture.createProducer();
  await observe(producer, "session-a");

  await expectCode(
    producer.dispatch("left_click", { target: 1, app_ref: appRef() }, context("session-b")),
    "ELEMENT_UNAVAILABLE",
  );
  fixture.window.stableId = "8";
  fixture.window.raw.window_id = 8;
  await expectCode(
    producer.dispatch("left_click", { target: 1, app_ref: { pid: 42 } }, context("session-a")),
    "STALE_STATE",
  );

  fixture.window.stableId = "7";
  fixture.window.raw.window_id = 7;
  await observe(producer, "session-a");
  fixture.button._staleAction = "press";
  await assert.rejects(
    producer.dispatch("left_click", { target: 1, app_ref: appRef() }, context("session-a")),
    (error) => {
      assert.equal(error.code, "ELEMENT_UNAVAILABLE");
      assert.equal(error.actionSent, false);
      return true;
    },
  );
});

test("only model-visible observations become incremental baselines", async () => {
  const fixture = createFixture();
  const producer = fixture.createProducer();
  const hidden = await observe(producer, "session-a", { tree_shown_to_model: false });
  fixture.field.value = "first change";
  const firstVisible = await producer.dispatch(
    "get_app_state",
    { app_ref: appRef(), tree_shown_to_model: true },
    context(),
  );
  assert.equal(hidden.mode, "full");
  assert.equal(firstVisible.mode, "full");

  fixture.field.value = "second change";
  const incremental = await producer.dispatch("get_app_state", { app_ref: appRef() }, context());
  assert.equal(incremental.mode, "incremental");
  assert.equal(incremental.base_state_id, firstVisible.state_id);
  assert.equal(incremental.changes.updated_count, 1);
  assert.equal(incremental.elements.length, 5);

  const forced = await observe(producer);
  assert.equal(forced.mode, "full");
  assert.equal(forced.base_state_id, null);
});

test("closeSession and dispose are isolated and idempotent", async () => {
  const fixture = createFixture();
  const producer = fixture.createProducer();
  await observe(producer, "session-a");
  await observe(producer, "session-b");
  await producer.closeSession(context("session-a"));
  await producer.dispatch("left_click", { target: 1, app_ref: appRef() }, context("session-b"));
  await expectCode(
    producer.dispatch("left_click", { target: 1, app_ref: appRef() }, context("session-a")),
    "ELEMENT_UNAVAILABLE",
  );
  await producer.dispose();
  await producer.dispose();
  await expectCode(producer.dispatch("list_apps", {}, context("session-b")), "CONTROL_STOPPED");
});
