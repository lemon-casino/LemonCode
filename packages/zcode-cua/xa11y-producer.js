/* eslint-disable max-lines -- 14 个严格 wire action 共用同一 snapshot owner；任务边界要求暂不拆出额外实现文件。 */
import { randomUUID as createRandomUUID } from "node:crypto";
import { executeMotionPath } from "./motion-profile.js";

export const XA11Y_PRODUCER_METHODS = Object.freeze([
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

const METHOD_NAMES = new Set(XA11Y_PRODUCER_METHODS);
const APP_REF_KEYS = ["name", "bundle_id", "pid", "window_id"];
const STRATEGIES = new Set(["auto", "a11y", "event"]);
const RETURN_STATES = new Set(["none", "compact", "full"]);
const DIRECTIONS = new Set(["up", "down", "left", "right"]);
const MOUSE_BUTTONS = new Set(["left", "right", "middle"]);
const PASTE_FORMATS = new Set(["text", "md", "html"]);
const RAW_BUNDLE_ID_KEYS = ["bundle_id", "bundleId", "bundle_identifier", "bundleIdentifier"];
const RAW_WINDOW_ID_KEYS = [
  "window_id",
  "windowId",
  "native_window_id",
  "nativeWindowId",
  "hwnd",
  "cg_window_id",
  "cgWindowId",
];

export class Xa11yProducerError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "Xa11yProducerError";
    this.code = code;
    this.actionSent = options.actionSent === true;
    this.retry = options.retry ?? "never";
    if (options.details !== undefined) this.details = options.details;
  }
}

function producerError(code, message, options) {
  return new Xa11yProducerError(code, message, options);
}

function normalizeMotionOptions(options) {
  const profile = options.motionProfile ?? "instant";
  if (profile !== "instant" && profile !== "smooth") {
    throw producerError("INVALID_REQUEST", "motion profile must be instant or smooth");
  }
  const durationMs = options.motionDurationMs ?? 160;
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 5_000) {
    throw producerError("INVALID_REQUEST", "motion duration must be between 0 and 5000 ms");
  }
  const segmentPixels = options.motionSegmentPixels ?? 80;
  if (!Number.isFinite(segmentPixels) || segmentPixels <= 0) {
    throw producerError("INVALID_REQUEST", "motion segment size must be positive");
  }
  const maxSegments = options.motionMaxSegments ?? 24;
  if (!Number.isSafeInteger(maxSegments) || maxSegments < 2 || maxSegments > 120) {
    throw producerError("INVALID_REQUEST", "motion max segments must be between 2 and 120");
  }
  return { profile, durationMs, segmentPixels, maxSegments };
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) throw producerError("INVALID_REQUEST", `${label} must be an object`);
  return value;
}

function requireExactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw producerError("INVALID_REQUEST", `${label} contains unknown fields`);
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw producerError("INVALID_REQUEST", `${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalBoolean(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean")
    throw producerError("INVALID_REQUEST", `${label} must be boolean`);
  return value;
}

function optionalEnum(value, values, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !values.has(value)) {
    throw producerError("INVALID_REQUEST", `${label} has an unsupported value`);
  }
  return value;
}

function parseAppRef(value, label = "app_ref") {
  const ref = requirePlainObject(value, label);
  requireExactKeys(ref, APP_REF_KEYS, label);
  const parsed = {};
  if (ref.name !== undefined) parsed.name = nonEmptyString(ref.name, `${label}.name`);
  if (ref.bundle_id !== undefined) {
    parsed.bundle_id = nonEmptyString(ref.bundle_id, `${label}.bundle_id`);
  }
  if (ref.pid !== undefined) {
    if (!Number.isSafeInteger(ref.pid) || ref.pid <= 0) {
      throw producerError("INVALID_REQUEST", `${label}.pid must be a positive safe integer`);
    }
    parsed.pid = ref.pid;
  }
  if (ref.window_id !== undefined) {
    if (!Number.isSafeInteger(ref.window_id) || ref.window_id < 0) {
      throw producerError(
        "INVALID_REQUEST",
        `${label}.window_id must be a non-negative safe integer`,
      );
    }
    parsed.window_id = ref.window_id;
  }
  // window_id 只缩小应用内窗口，不能单独充当应用身份；否则跨进程复用的 native id 会歧义。
  if (parsed.name === undefined && parsed.bundle_id === undefined && parsed.pid === undefined) {
    throw producerError("INVALID_APP", `${label} must identify an application`);
  }
  return parsed;
}

function parseTarget(value, label = "target") {
  if (Number.isSafeInteger(value) && value >= 0) return { type: "element", index: value };
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((coordinate) => Number.isSafeInteger(coordinate) && coordinate >= 0)
  ) {
    return { type: "coordinate", x: value[0], y: value[1] };
  }
  if (!isPlainObject(value)) {
    throw producerError("INVALID_REQUEST", `${label} must be an element index or coordinate`);
  }
  if (value.type === "element") {
    requireExactKeys(value, ["type", "index"], label);
    if (!Number.isSafeInteger(value.index) || value.index < 0) {
      throw producerError("INVALID_REQUEST", `${label}.index must be a non-negative safe integer`);
    }
    return { type: "element", index: value.index };
  }
  if (value.type === "coordinate") {
    requireExactKeys(value, ["type", "x", "y", "frame_id"], label);
    if (
      !Number.isSafeInteger(value.x) ||
      value.x < 0 ||
      !Number.isSafeInteger(value.y) ||
      value.y < 0
    ) {
      throw producerError("INVALID_REQUEST", `${label} coordinates must be non-negative integers`);
    }
    const target = { type: "coordinate", x: value.x, y: value.y };
    if (value.frame_id !== undefined) {
      target.frameId = nonEmptyString(value.frame_id, `${label}.frame_id`);
    }
    return target;
  }
  throw producerError("INVALID_REQUEST", `${label}.type is unsupported`);
}

function parseModifiers(value) {
  if (value === undefined || value === "") return [];
  if (typeof value !== "string") {
    throw producerError("INVALID_REQUEST", "modifiers must be a '+'-separated string");
  }
  return value.split("+").map((part) => normalizeKey(part, true));
}

function normalizeKey(value, modifier = false) {
  const key = nonEmptyString(value, modifier ? "modifier" : "key");
  const lower = key.toLowerCase().replaceAll("_", "");
  const named = {
    alt: "Alt",
    option: "Alt",
    ctrl: "Ctrl",
    control: "Ctrl",
    controll: "Ctrl",
    cmd: "Meta",
    command: "Meta",
    meta: "Meta",
    super: "Meta",
    win: "Meta",
    shift: "Shift",
    return: "Enter",
    enter: "Enter",
    esc: "Escape",
    escape: "Escape",
    up: "ArrowUp",
    arrowup: "ArrowUp",
    down: "ArrowDown",
    arrowdown: "ArrowDown",
    left: "ArrowLeft",
    arrowleft: "ArrowLeft",
    right: "ArrowRight",
    arrowright: "ArrowRight",
    backspace: "Backspace",
    delete: "Delete",
    tab: "Tab",
    space: "Space",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
  }[lower];
  if (named) return named;
  if (!modifier && (key.length === 1 || /^f(?:[1-9]|1[0-9]|2[0-4])$/iu.test(key))) {
    return key.length === 1 ? key : key.toUpperCase();
  }
  if (modifier) throw producerError("INVALID_REQUEST", `unsupported modifier: ${key}`);
  return key;
}

function parseKeyChord(text) {
  const parts = nonEmptyString(text, "text").split("+");
  if (parts.some((part) => part.trim().length === 0)) {
    throw producerError("INVALID_REQUEST", "text contains an empty key chord part");
  }
  const key = normalizeKey(parts.at(-1));
  const held = parts.slice(0, -1).map((part) => normalizeKey(part, true));
  return { key, held };
}

function optionalAppRef(args) {
  return args.app_ref === undefined ? undefined : parseAppRef(args.app_ref);
}

function parseReturnState(args) {
  return optionalEnum(args.return_state, RETURN_STATES, "none", "return_state");
}

function parseStrategy(args) {
  return optionalEnum(args.strategy, STRATEGIES, "auto", "strategy");
}

function parseParams(method, rawParams) {
  const args = rawParams === undefined ? {} : requirePlainObject(rawParams, "params");
  switch (method) {
    case "list_apps":
      requireExactKeys(args, [], "params");
      return {};
    case "list_windows":
      requireExactKeys(args, ["app_ref"], "params");
      return { appRef: parseAppRef(args.app_ref) };
    case "get_app_state":
      requireExactKeys(
        args,
        ["app_ref", "include_screenshot", "disable_diffing", "tree_shown_to_model"],
        "params",
      );
      return {
        appRef: parseAppRef(args.app_ref),
        includeScreenshot: optionalBoolean(args.include_screenshot, false, "include_screenshot"),
        disableDiffing: optionalBoolean(args.disable_diffing, false, "disable_diffing"),
        treeShownToModel: optionalBoolean(args.tree_shown_to_model, true, "tree_shown_to_model"),
      };
    case "left_click":
      requireExactKeys(
        args,
        [
          "target",
          "mouse_button",
          "click_count",
          "modifiers",
          "strategy",
          "app_ref",
          "return_state",
        ],
        "params",
      );
      if (
        args.click_count !== undefined &&
        (!Number.isSafeInteger(args.click_count) || args.click_count <= 0)
      ) {
        throw producerError("INVALID_REQUEST", "click_count must be a positive safe integer");
      }
      return {
        target: parseTarget(args.target),
        mouseButton: optionalEnum(args.mouse_button, MOUSE_BUTTONS, "left", "mouse_button"),
        clickCount: args.click_count ?? 1,
        modifiers: parseModifiers(args.modifiers),
        strategy: parseStrategy(args),
        appRef: optionalAppRef(args),
        returnState: parseReturnState(args),
      };
    case "left_click_drag":
      requireExactKeys(
        args,
        ["from_target", "to", "modifiers", "app_ref", "return_state"],
        "params",
      );
      return {
        fromTarget: parseTarget(args.from_target, "from_target"),
        toTarget: parseTarget(args.to, "to"),
        modifiers: parseModifiers(args.modifiers),
        appRef: optionalAppRef(args),
        returnState: parseReturnState(args),
      };
    case "scroll":
      requireExactKeys(
        args,
        ["target", "scroll_direction", "scroll_amount", "strategy", "app_ref", "return_state"],
        "params",
      );
      if (!DIRECTIONS.has(args.scroll_direction)) {
        throw producerError("INVALID_REQUEST", "scroll_direction is unsupported");
      }
      if (
        typeof args.scroll_amount !== "number" ||
        !Number.isFinite(args.scroll_amount) ||
        args.scroll_amount < 0
      ) {
        throw producerError(
          "INVALID_REQUEST",
          "scroll_amount must be a finite non-negative number",
        );
      }
      return {
        target: parseTarget(args.target),
        direction: args.scroll_direction,
        amount: Math.min(args.scroll_amount, 100),
        strategy: parseStrategy(args),
        appRef: optionalAppRef(args),
        returnState: parseReturnState(args),
      };
    case "type":
      requireExactKeys(args, ["text", "target", "app_ref", "strategy", "return_state"], "params");
      if (typeof args.text !== "string")
        throw producerError("INVALID_REQUEST", "text must be a string");
      return {
        text: args.text,
        target: args.target === undefined ? undefined : parseTarget(args.target),
        appRef: optionalAppRef(args),
        strategy: parseStrategy(args),
        returnState: parseReturnState(args),
      };
    case "set_value":
      requireExactKeys(args, ["target", "value", "strategy", "app_ref", "return_state"], "params");
      if (typeof args.value !== "string")
        throw producerError("INVALID_REQUEST", "value must be a string");
      return {
        target: parseTarget(args.target),
        value: args.value,
        strategy: parseStrategy(args),
        appRef: optionalAppRef(args),
        returnState: parseReturnState(args),
      };
    case "select_text": {
      requireExactKeys(args, ["target", "text_range", "app_ref", "return_state"], "params");
      let textRange;
      if (args.text_range !== undefined) {
        if (
          !Array.isArray(args.text_range) ||
          args.text_range.length !== 2 ||
          !args.text_range.every((part) => Number.isSafeInteger(part) && part >= 0)
        ) {
          throw producerError("INVALID_REQUEST", "text_range must be [start, length]");
        }
        textRange = [args.text_range[0], args.text_range[1]];
      }
      return {
        target: parseTarget(args.target),
        textRange,
        appRef: optionalAppRef(args),
        returnState: parseReturnState(args),
      };
    }
    case "key":
      requireExactKeys(
        args,
        ["text", "repeat", "hold_seconds", "app_ref", "strategy", "return_state"],
        "params",
      );
      if (
        args.repeat !== undefined &&
        (!Number.isSafeInteger(args.repeat) || args.repeat <= 0 || args.repeat > 100)
      ) {
        throw producerError("INVALID_REQUEST", "repeat must be an integer from 1 to 100");
      }
      if (
        args.hold_seconds !== undefined &&
        (typeof args.hold_seconds !== "number" ||
          !Number.isFinite(args.hold_seconds) ||
          args.hold_seconds < 0 ||
          args.hold_seconds > 60)
      ) {
        throw producerError("INVALID_REQUEST", "hold_seconds must be between 0 and 60");
      }
      return {
        chord: parseKeyChord(args.text),
        repeat: args.repeat ?? 1,
        holdSeconds: args.hold_seconds ?? 0,
        appRef: optionalAppRef(args),
        strategy: parseStrategy(args),
        returnState: parseReturnState(args),
      };
    case "paste":
      requireExactKeys(args, ["text", "format", "app_ref", "return_state"], "params");
      if (typeof args.text !== "string")
        throw producerError("INVALID_REQUEST", "text must be a string");
      return {
        text: args.text,
        format: optionalEnum(args.format, PASTE_FORMATS, "text", "format"),
        appRef: optionalAppRef(args),
        returnState: parseReturnState(args),
      };
    case "perform_action":
      requireExactKeys(args, ["target", "action", "app_ref", "return_state"], "params");
      return {
        target: parseTarget(args.target),
        action: nonEmptyString(args.action, "action"),
        appRef: optionalAppRef(args),
        returnState: parseReturnState(args),
      };
    case "request_access": {
      requireExactKeys(args, ["capabilities"], "params");
      if (
        args.capabilities !== undefined &&
        (!Array.isArray(args.capabilities) ||
          args.capabilities.some((item) => typeof item !== "string" || item.trim().length === 0))
      ) {
        throw producerError("INVALID_REQUEST", "capabilities must be non-empty strings");
      }
      return { capabilities: args.capabilities?.map((item) => item.trim()) };
    }
    case "stop_computer_control":
      requireExactKeys(args, ["reason"], "params");
      if (args.reason !== undefined && typeof args.reason !== "string") {
        throw producerError("INVALID_REQUEST", "reason must be a string");
      }
      return { reason: args.reason };
    default:
      throw producerError("INVALID_REQUEST", "unknown Computer Use method");
  }
}

function parseContext(value) {
  const context = requirePlainObject(value, "context");
  const workspaceKey = nonEmptyString(context.workspaceKey, "context.workspaceKey");
  const sessionId = nonEmptyString(context.sessionId, "context.sessionId");
  return { raw: context, workspaceKey, sessionId, key: `${workspaceKey}\u0000${sessionId}` };
}

async function defaultLoadXa11y() {
  const imported = await import("@crowecawcaw/xa11y");
  // xa11y 0.15.0 是 CommonJS；Node ESM 的具名导出探测不会暴露 inputSim/screenshot。
  // 必须优先读 default，否则真机只看到 App 而动作与截图在运行期才报 undefined。
  return imported.default ?? imported;
}

function readProperty(value, key, fallback = null) {
  try {
    return value?.[key] ?? fallback;
  } catch {
    return fallback;
  }
}

function readRaw(value) {
  const raw = readProperty(value, "raw", {});
  return isPlainObject(raw) ? raw : {};
}

function readExplicitString(raw, keys) {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function readWindowId(window) {
  const raw = readRaw(window);
  for (const key of RAW_WINDOW_ID_KEYS) {
    if (Number.isSafeInteger(raw[key]) && raw[key] >= 0) return raw[key];
  }
  const stableId = readProperty(window, "stableId");
  if (typeof stableId === "string" && /^(?:0|[1-9]\d*)$/u.test(stableId)) {
    const parsed = Number(stableId);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function readBounds(value) {
  const bounds = readProperty(value, "bounds");
  if (!isPlainObject(bounds)) return null;
  const fields = [bounds.x, bounds.y, bounds.width, bounds.height];
  return fields.every((field) => typeof field === "number" && Number.isFinite(field))
    ? fields
    : null;
}

function appRecord(app) {
  const root = typeof app?.asElement === "function" ? app.asElement() : undefined;
  const raw = readRaw(root);
  const pid = readProperty(app, "pid");
  const name = readProperty(app, "name");
  return {
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    name: typeof name === "string" ? name : null,
    bundle_id: readExplicitString(raw, RAW_BUNDLE_ID_KEYS),
    active: readProperty(app, "isForeground", false) === true,
  };
}

function windowRecord(window, index) {
  const raw = readRaw(window);
  const explicitMain = raw.main ?? raw.is_main ?? raw.ax_main;
  const subrole = readExplicitString(raw, ["subrole", "ax_subrole", "axSubrole"]);
  return {
    index,
    window_id: readWindowId(window),
    title: typeof readProperty(window, "name") === "string" ? readProperty(window, "name") : null,
    bounds: readBounds(window),
    main: typeof explicitMain === "boolean" ? explicitMain : null,
    focused: readProperty(window, "active", false) === true,
    onscreen: readProperty(window, "visible", false) === true,
    ...(subrole === null ? {} : { subrole }),
  };
}

function matchesAppRef(record, ref) {
  return (
    (ref.name === undefined || record.name === ref.name) &&
    (ref.bundle_id === undefined || record.bundle_id === ref.bundle_id) &&
    (ref.pid === undefined || record.pid === ref.pid)
  );
}

function internalWindowIdentity(window, record) {
  const stableId = readProperty(window, "stableId");
  if (typeof stableId === "string" && stableId.length > 0) return `stable:${stableId}`;
  if (record.window_id !== null) return `native:${record.window_id}`;
  return null;
}

function canonicalAppRef(app, window) {
  const ref = {};
  if (app.pid !== null) ref.pid = app.pid;
  else if (app.bundle_id !== null) ref.bundle_id = app.bundle_id;
  else if (app.name !== null) ref.name = app.name;
  if (window?.window_id !== null && window?.window_id !== undefined) {
    ref.window_id = window.window_id;
  }
  return ref;
}

function mapXa11yError(error, fallbackCode, actionSent = false) {
  if (error instanceof Xa11yProducerError) return error;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "PermissionDeniedError" || name === "AccessibilityNotEnabledError") {
    return producerError("PERMISSION_DENIED", message, { actionSent: false, retry: "never" });
  }
  if (name === "SelectorNotMatchedError") {
    return producerError("ELEMENT_UNAVAILABLE", message, {
      actionSent: false,
      retry: "reobserve",
    });
  }
  if (name === "ActionNotSupportedError" || name === "InvalidActionDataError") {
    return producerError("ACTION_UNAVAILABLE", message, { actionSent: false, retry: "reobserve" });
  }
  if (name === "TimeoutError") {
    return producerError("TIMEOUT", message, { actionSent, retry: "retry" });
  }
  return producerError(fallbackCode, message || "xa11y operation failed", {
    actionSent,
    retry: actionSent ? "reobserve" : "never",
  });
}

function safeActions(element) {
  const actions = readProperty(element, "actions", []);
  return Array.isArray(actions)
    ? actions.filter((action) => typeof action === "string").toSorted()
    : [];
}

function pureElementRow(element, index, parentIndex, depth) {
  const role = readProperty(element, "role");
  const name = readProperty(element, "name");
  const value = readProperty(element, "value");
  const description = readProperty(element, "description");
  const stableId = readProperty(element, "stableId");
  return {
    index,
    parent_index: parentIndex,
    depth,
    kind: typeof role === "string" ? role : null,
    role: typeof role === "string" ? role : null,
    title: typeof name === "string" ? name : null,
    name: typeof name === "string" ? name : null,
    value: typeof value === "string" ? value : null,
    description: typeof description === "string" ? description : null,
    stable_id: typeof stableId === "string" ? stableId : null,
    bounds: readBounds(element),
    actions: safeActions(element),
    enabled: readProperty(element, "enabled", false) === true,
    visible: readProperty(element, "visible", false) === true,
    focused: readProperty(element, "focused", false) === true,
    active: readProperty(element, "active", false) === true,
    checked: readProperty(element, "checked"),
    selected: readProperty(element, "selected", false) === true,
    expanded: readProperty(element, "expanded"),
    editable: readProperty(element, "editable", false) === true,
    focusable: readProperty(element, "focusable", false) === true,
  };
}

async function captureElementTree(root, maxElements) {
  const entries = [];
  async function visit(element, parentIndex, depth, path) {
    if (entries.length >= maxElements) {
      throw producerError("STRUCTURED_STATE_UNAVAILABLE", "accessibility tree exceeds limit");
    }
    const index = entries.length;
    const row = pureElementRow(element, index, parentIndex, depth);
    entries.push({ handle: element, row, path });
    let children;
    try {
      children = await element.children();
    } catch (error) {
      throw mapXa11yError(error, "STRUCTURED_STATE_UNAVAILABLE");
    }
    if (!Array.isArray(children)) {
      throw producerError("STRUCTURED_STATE_UNAVAILABLE", "xa11y children() returned invalid data");
    }
    for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
      await visit(children[childIndex], index, depth + 1, `${path}.${childIndex}`);
    }
  }
  await visit(root, null, 0, "0");
  return entries;
}

function elementFingerprint(row) {
  return JSON.stringify({
    ...row,
    index: undefined,
    parent_index: undefined,
    depth: undefined,
  });
}

function diffElements(previousEntries, currentEntries) {
  const previous = new Map(previousEntries.map((entry) => [entry.path, entry]));
  const current = new Map(currentEntries.map((entry) => [entry.path, entry]));
  const added = [];
  const updated = [];
  const removed = [];
  for (const [path, entry] of current) {
    const old = previous.get(path);
    if (!old) added.push(entry.row);
    else if (elementFingerprint(old.row) !== elementFingerprint(entry.row)) updated.push(entry.row);
  }
  for (const [path, entry] of previous) {
    if (!current.has(path)) {
      removed.push({ index: entry.row.index, stable_id: entry.row.stable_id });
    }
  }
  return {
    added_count: added.length,
    removed_count: removed.length,
    updated_count: updated.length,
    added,
    removed,
    updated,
  };
}

function renderElement(row) {
  const indent = "  ".repeat(row.depth);
  const title = row.title === null ? "" : ` ${JSON.stringify(row.title)}`;
  const value = row.value === null ? "" : ` = ${JSON.stringify(row.value)}`;
  const actions = row.actions.length === 0 ? "" : ` (actions: ${row.actions.join(",")})`;
  return `${indent}[${row.index}] ${row.kind ?? "unknown"}${title}${value}${actions}`;
}

function renderStateText(app, window, stateId, entries, changes) {
  const header = [
    `state_id: ${stateId}`,
    `app: name=${JSON.stringify(app.name)} pid=${app.pid ?? "null"} bundle_id=${JSON.stringify(app.bundle_id)}`,
    `window: title=${JSON.stringify(window.title)} window_id=${window.window_id ?? "null"}`,
  ];
  if (!changes) return [...header, ...entries.map((entry) => renderElement(entry.row))].join("\n");
  const changedRows = [...changes.added, ...changes.updated].toSorted((a, b) => a.index - b.index);
  const removed = changes.removed.map((row) => `[-${row.index}] removed`);
  return [...header, ...changedRows.map(renderElement), ...removed].join("\n");
}

function sessionMaps(container, sessionKey) {
  let value = container.get(sessionKey);
  if (!value) {
    value = new Map();
    container.set(sessionKey, value);
  }
  return value;
}

export function createXa11yProducer(options = {}) {
  const loadXa11y = options.loadXa11y ?? defaultLoadXa11y;
  const makeId = options.randomUUID ?? createRandomUUID;
  const delay =
    options.delay ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const maxElements =
    Number.isSafeInteger(options.maxElements) && options.maxElements > 0
      ? options.maxElements
      : 10_000;
  const motion = normalizeMotionOptions(options);
  const snapshots = new Map();
  const baselines = new Map();
  let modulePromise;
  let inputSimPromise;
  let lastPointerPoint;
  let disposed = false;

  async function xa11y() {
    modulePromise ??= Promise.resolve().then(loadXa11y);
    let loaded;
    try {
      loaded = await modulePromise;
    } catch (error) {
      modulePromise = undefined;
      throw mapXa11yError(error, "HELPER_UNAVAILABLE");
    }
    if (!loaded?.App || typeof loaded.App.list !== "function") {
      throw producerError("HELPER_UNAVAILABLE", "xa11y App API is unavailable");
    }
    return loaded;
  }

  async function inputSim() {
    inputSimPromise ??= xa11y().then((module) => {
      if (typeof module.inputSim !== "function") {
        throw producerError("HELPER_UNAVAILABLE", "xa11y inputSim API is unavailable");
      }
      return module.inputSim();
    });
    try {
      return await inputSimPromise;
    } catch (error) {
      inputSimPromise = undefined;
      throw mapXa11yError(error, "HELPER_UNAVAILABLE");
    }
  }

  async function listAppHandles() {
    try {
      const apps = await (await xa11y()).App.list();
      if (!Array.isArray(apps)) throw new Error("xa11y App.list() returned invalid data");
      return apps.map((handle) => ({ handle, record: appRecord(handle) }));
    } catch (error) {
      throw mapXa11yError(error, "INTERNAL");
    }
  }

  async function resolveApp(ref) {
    const matches = (await listAppHandles()).filter(({ record }) => matchesAppRef(record, ref));
    if (matches.length === 0) {
      throw producerError("APP_NOT_FOUND", "application reference did not match a running app", {
        retry: "reobserve",
      });
    }
    if (matches.length !== 1) {
      throw producerError("AMBIGUOUS_APP", "application reference matched more than one app", {
        retry: "never",
      });
    }
    return matches[0];
  }

  async function listWindowHandles(app) {
    try {
      const windows = await app.handle.windows();
      if (!Array.isArray(windows)) throw new Error("xa11y App.windows() returned invalid data");
      return windows.map((handle, index) => ({ handle, record: windowRecord(handle, index) }));
    } catch (error) {
      throw mapXa11yError(error, "INTERNAL");
    }
  }

  async function resolveAppAndWindow(ref) {
    const app = await resolveApp(ref);
    const windows = await listWindowHandles(app);
    let matches;
    let selection = "unknown";
    if (ref.window_id !== undefined) {
      matches = windows.filter(({ record }) => record.window_id === ref.window_id);
      selection = `window:${ref.window_id}`;
    } else {
      const focused = windows.filter(({ record }) => record.focused);
      const main = windows.filter(({ record }) => record.main === true);
      if (focused.length === 1) {
        matches = focused;
        selection = "focused";
      } else if (main.length === 1) {
        matches = main;
        selection = "main";
      } else if (windows.length === 1) {
        matches = windows;
        selection = "sole";
      } else {
        matches = [];
      }
    }
    if (matches.length !== 1) {
      throw producerError("STALE_STATE", "target window is unavailable or ambiguous", {
        retry: "reobserve",
      });
    }
    const window = matches[0];
    const stableIdentity = internalWindowIdentity(window.handle, window.record);
    const pid = app.record.pid;
    if (pid === null) {
      throw producerError("INVALID_APP", "target app has no process identity");
    }
    // 平台未给 stableId/window_id 时仍允许读取树并返回 window_id:null；内部 selection key
    // 只用于保存本次观察，绝不冒充可回传的窗口身份。此类 snapshot 的动作会在复核时拒绝。
    const identity = stableIdentity ?? `selection:${selection}`;
    return {
      app,
      window,
      targetKey: `${pid}\u0000${identity}`,
      windowIdentityStable: stableIdentity !== null,
    };
  }

  async function listApps() {
    return (await listAppHandles()).map(({ record }) => ({ ...record }));
  }

  async function listWindows(params) {
    const app = await resolveApp(params.appRef);
    let windows = await listWindowHandles(app);
    if (params.appRef.window_id !== undefined) {
      windows = windows.filter(({ record }) => record.window_id === params.appRef.window_id);
      if (windows.length !== 1) {
        throw producerError("STALE_STATE", "window_id did not resolve uniquely", {
          retry: "reobserve",
        });
      }
    }
    return windows.map(({ record }) => ({ ...record }));
  }

  async function captureScreenshot(module, windowHandle) {
    if (typeof module.screenshot !== "function") {
      throw producerError("HELPER_UNAVAILABLE", "xa11y screenshot API is unavailable");
    }
    const shot = await module.screenshot({ element: windowHandle });
    const width = readProperty(shot, "width");
    const height = readProperty(shot, "height");
    if (
      !Number.isSafeInteger(width) ||
      width <= 0 ||
      !Number.isSafeInteger(height) ||
      height <= 0
    ) {
      throw new Error("xa11y screenshot dimensions are invalid");
    }
    const png = shot.toPng();
    if (!Buffer.isBuffer(png)) throw new Error("xa11y screenshot PNG is invalid");
    return { shot, width, height, png };
  }

  async function getAppState(params, context) {
    const resolved = await resolveAppAndWindow(params.appRef);
    const entries = await captureElementTree(resolved.window.handle, maxElements);
    const sessionSnapshots = sessionMaps(snapshots, context.key);
    const previousSnapshot = sessionSnapshots.get(resolved.targetKey);
    let frame = params.includeScreenshot ? undefined : previousSnapshot?.frame;
    let screenshot;
    let nonActionableReason;
    if (params.includeScreenshot) {
      try {
        const captured = await captureScreenshot(await xa11y(), resolved.window.handle);
        frame = {
          ...captured,
          frameId: makeId(),
          mappingAvailable: readProperty(captured.shot, "mappingAvailable", false) === true,
        };
        screenshot = {
          data: captured.png.toString("base64"),
          mime_type: "image/png",
          width: captured.width,
          height: captured.height,
          frame_id: frame.frameId,
        };
        if (!frame.mappingAvailable)
          nonActionableReason = "screenshot_coordinate_mapping_unavailable";
      } catch (error) {
        frame = undefined;
        nonActionableReason = `screenshot_unavailable:${error instanceof Error ? error.name : "Error"}`;
      }
    }

    const stateId = makeId();
    const app = { ...resolved.app.record };
    const window = { ...resolved.window.record };
    const sessionBaselines = sessionMaps(baselines, context.key);
    const baseline = resolved.windowIdentityStable
      ? sessionBaselines.get(resolved.targetKey)
      : undefined;
    const full = params.disableDiffing || !baseline;
    const changes = full ? undefined : diffElements(baseline.entries, entries);
    const snapshot = {
      stateId,
      targetKey: resolved.targetKey,
      app,
      window,
      appRef: canonicalAppRef(app, window),
      appHandle: resolved.app.handle,
      windowHandle: resolved.window.handle,
      windowIdentityStable: resolved.windowIdentityStable,
      entries,
      frame,
    };
    sessionSnapshots.set(resolved.targetKey, snapshot);
    if (params.treeShownToModel && resolved.windowIdentityStable) {
      sessionBaselines.set(resolved.targetKey, snapshot);
    }

    const result = {
      state_id: stateId,
      mode: full ? "full" : "incremental",
      base_state_id: full ? null : baseline.stateId,
      app,
      window,
      focused_element: entries.find((entry) => entry.row.focused)?.row.index ?? null,
      elements: entries.map((entry) => ({ ...entry.row })),
      text: renderStateText(app, window, stateId, entries, changes),
      ...(changes ? { changes } : {}),
      ...(screenshot ? { screenshot } : {}),
      ...(frame ? { frame_id: frame.frameId } : {}),
      ...(nonActionableReason ? { non_actionable_reason: nonActionableReason } : {}),
    };
    return result;
  }

  async function snapshotFor(appRef, context) {
    const sessionSnapshots = snapshots.get(context.key);
    if (!sessionSnapshots || sessionSnapshots.size === 0) {
      throw producerError("ELEMENT_UNAVAILABLE", "session has no accessibility snapshot", {
        retry: "reobserve",
      });
    }
    if (appRef) {
      const resolved = await resolveAppAndWindow(appRef);
      const snapshot = sessionSnapshots.get(resolved.targetKey);
      if (!snapshot) {
        throw producerError("STALE_STATE", "latest app/window snapshot is unavailable", {
          retry: "reobserve",
        });
      }
      if (!snapshot.windowIdentityStable || !resolved.windowIdentityStable) {
        throw producerError("STALE_STATE", "window identity cannot be revalidated", {
          retry: "reobserve",
        });
      }
      return { snapshot, resolved };
    }
    if (sessionSnapshots.size !== 1) {
      throw producerError("ELEMENT_UNAVAILABLE", "target snapshot is ambiguous", {
        retry: "reobserve",
      });
    }
    const snapshot = sessionSnapshots.values().next().value;
    const resolved = await resolveAppAndWindow(snapshot.appRef);
    if (
      resolved.targetKey !== snapshot.targetKey ||
      !snapshot.windowIdentityStable ||
      !resolved.windowIdentityStable
    ) {
      throw producerError("STALE_STATE", "target window changed after observation", {
        retry: "reobserve",
      });
    }
    return { snapshot, resolved };
  }

  async function resolveTarget(target, appRef, context) {
    const { snapshot, resolved } = await snapshotFor(appRef, context);
    if (target.type === "element") {
      const entry = snapshot.entries[target.index];
      if (!entry || entry.row.index !== target.index) {
        throw producerError("ELEMENT_UNAVAILABLE", "element index is unknown or stale", {
          retry: "reobserve",
        });
      }
      return { kind: "element", nativeTarget: entry.handle, entry, snapshot, resolved };
    }
    const frame = snapshot.frame;
    if (!frame || !frame.mappingAvailable || typeof frame.shot?.imageToDesktop !== "function") {
      throw producerError("STALE_STATE", "coordinate target has no actionable raster", {
        retry: "reobserve",
      });
    }
    if (target.frameId !== undefined && target.frameId !== frame.frameId) {
      throw producerError("STALE_STATE", "coordinate frame_id is stale", { retry: "reobserve" });
    }
    if (target.x >= frame.width || target.y >= frame.height) {
      throw producerError("INVALID_REQUEST", "coordinate is outside the referenced raster");
    }
    const desktop = frame.shot.imageToDesktop(target.x, target.y);
    if (
      !Array.isArray(desktop) ||
      desktop.length !== 2 ||
      desktop.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate))
    ) {
      throw producerError("STALE_STATE", "xa11y coordinate mapping failed", {
        retry: "reobserve",
      });
    }
    return { kind: "coordinate", nativeTarget: desktop, snapshot, resolved };
  }

  function ensureForeground(resolved, appRef) {
    if (!resolved.app.record.active) {
      throw producerError(
        "FOREGROUND_REQUIRED",
        "event input requires the target app to be foreground",
      );
    }
    if (appRef?.window_id !== undefined && !resolved.window.record.focused) {
      throw producerError(
        "FOREGROUND_REQUIRED",
        "event input requires the target window to be focused",
      );
    }
  }

  async function invokeAction(work, fallbackCode = "INTERNAL") {
    try {
      await work();
    } catch (error) {
      throw mapXa11yError(error, fallbackCode, true);
    }
  }

  async function moveAlongConfiguredPath(sim, from, to) {
    await executeMotionPath(
      {
        async moveTo(point) {
          await sim.moveTo(point);
          lastPointerPoint = [point[0], point[1]];
        },
      },
      from,
      to,
      { ...motion, sleep: delay },
    );
  }

  async function prepareCoordinatePointer(sim, target, forceUnknownMove = false) {
    if (target.kind !== "coordinate") {
      lastPointerPoint = undefined;
      return;
    }
    const destination = [target.nativeTarget[0], target.nativeTarget[1]];
    if (motion.profile === "smooth" && lastPointerPoint) {
      await moveAlongConfiguredPath(sim, lastPointerPoint, destination);
    } else if (motion.profile === "smooth" && forceUnknownMove) {
      await sim.moveTo(destination);
      lastPointerPoint = destination;
    }
  }

  function rememberCoordinateTarget(target) {
    lastPointerPoint =
      target.kind === "coordinate" ? [target.nativeTarget[0], target.nativeTarget[1]] : undefined;
  }

  async function completeAction(params, context, targetResolution) {
    if (params.returnState === "none") return { action_sent: true };
    const appRef = params.appRef ?? targetResolution?.snapshot.appRef;
    if (!appRef || Object.keys(appRef).length === 0) {
      throw producerError("INVALID_APP", "return_state requires an app reference", {
        actionSent: true,
        retry: "reobserve",
      });
    }
    let state;
    try {
      state = await getAppState(
        {
          appRef,
          includeScreenshot: false,
          disableDiffing: params.returnState === "full",
          treeShownToModel: true,
        },
        context,
      );
    } catch (error) {
      // 动作已经完成后，随调用返回的观察失败不能把 actionSent 重新写成 false。
      const mapped = mapXa11yError(error, "INTERNAL", true);
      mapped.actionSent = true;
      mapped.retry = "reobserve";
      throw mapped;
    }
    return { action_sent: true, state };
  }

  async function click(params, context) {
    const target = await resolveTarget(params.target, params.appRef, context);
    const canPress =
      target.kind === "element" &&
      params.mouseButton === "left" &&
      params.clickCount === 1 &&
      params.modifiers.length === 0 &&
      target.entry.row.actions.includes("press");
    if (params.strategy === "a11y" || (params.strategy === "auto" && canPress)) {
      if (!canPress)
        throw producerError("ACTION_UNAVAILABLE", "element has no compatible press action");
      await invokeAction(() => target.nativeTarget.press(), "ACTION_UNAVAILABLE");
    } else {
      ensureForeground(target.resolved, params.appRef);
      const sim = await inputSim();
      await invokeAction(async () => {
        await prepareCoordinatePointer(sim, target);
        await sim.click(target.nativeTarget, {
          button: params.mouseButton,
          count: params.clickCount,
          held: params.modifiers,
        });
        rememberCoordinateTarget(target);
      });
    }
    return completeAction(params, context, target);
  }

  async function drag(params, context) {
    const from = await resolveTarget(params.fromTarget, params.appRef, context);
    const to = await resolveTarget(params.toTarget, params.appRef, context);
    if (from.snapshot.stateId !== to.snapshot.stateId) {
      throw producerError("STALE_STATE", "drag endpoints belong to different snapshots", {
        retry: "reobserve",
      });
    }
    ensureForeground(from.resolved, params.appRef);
    const sim = await inputSim();
    await invokeAction(async () => {
      if (motion.profile !== "smooth" || from.kind !== "coordinate" || to.kind !== "coordinate") {
        await sim.drag(from.nativeTarget, to.nativeTarget, { held: params.modifiers });
        rememberCoordinateTarget(to);
        return;
      }
      // Bug 根因：轨迹模块此前没有任何产品调用点，打包后的 Helper 永远只走 xa11y 默认拖拽。
      // 坐标拖拽在同一 inputSim owner 内显式按下/移动/释放，异常时也必须释放按键和鼠标。
      await prepareCoordinatePointer(sim, from, true);
      const held = [];
      let mousePressed = false;
      let failure;
      try {
        for (const modifier of params.modifiers) {
          await sim.keyDown(modifier);
          held.push(modifier);
        }
        await sim.mouseDown("left");
        mousePressed = true;
        await moveAlongConfiguredPath(sim, from.nativeTarget, to.nativeTarget);
      } catch (error) {
        failure = error;
      }
      if (mousePressed) {
        try {
          await sim.mouseUp("left");
        } catch (error) {
          failure ??= error;
        }
      }
      for (const modifier of held.toReversed()) {
        try {
          await sim.keyUp(modifier);
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure) throw failure;
      rememberCoordinateTarget(to);
    });
    return completeAction(params, context, from);
  }

  function scrollDelta(target, direction, amount) {
    const bounds = target.snapshot.window.bounds;
    if (!Array.isArray(bounds)) {
      throw producerError("ACTION_UNAVAILABLE", "window bounds are unavailable for page scrolling");
    }
    const distance = Math.round(
      (direction === "up" || direction === "down" ? bounds[3] : bounds[2]) * amount,
    );
    if (direction === "up") return [0, -distance];
    if (direction === "down") return [0, distance];
    if (direction === "left") return [-distance, 0];
    return [distance, 0];
  }

  async function scroll(params, context) {
    const target = await resolveTarget(params.target, params.appRef, context);
    const action = `scroll_${params.direction}`;
    const canUseSemantic = target.kind === "element" && target.entry.row.actions.includes(action);
    if (params.strategy === "a11y" || (params.strategy === "auto" && canUseSemantic)) {
      if (!canUseSemantic) {
        throw producerError("ACTION_UNAVAILABLE", `element does not advertise ${action}`);
      }
      for (let count = 0; count < Math.ceil(params.amount); count += 1) {
        await invokeAction(() => target.nativeTarget.performAction(action), "ACTION_UNAVAILABLE");
      }
    } else if (params.amount > 0) {
      ensureForeground(target.resolved, params.appRef);
      const [dx, dy] = scrollDelta(target, params.direction, params.amount);
      const sim = await inputSim();
      await invokeAction(async () => {
        await prepareCoordinatePointer(sim, target);
        await sim.scroll(target.nativeTarget, dx, dy);
        rememberCoordinateTarget(target);
      });
    }
    return completeAction(params, context, target);
  }

  async function typeText(params, context) {
    let target;
    if (params.target) target = await resolveTarget(params.target, params.appRef, context);
    const canUseSemantic =
      target?.kind === "element" && typeof target.nativeTarget.typeText === "function";
    if (params.strategy === "a11y" || (params.strategy === "auto" && canUseSemantic)) {
      if (!canUseSemantic)
        throw producerError(
          "ACTION_UNAVAILABLE",
          "type requires an element target for a11y strategy",
        );
      await invokeAction(() => target.nativeTarget.typeText(params.text), "ACTION_UNAVAILABLE");
    } else {
      let resolved = target?.resolved;
      if (!resolved && params.appRef) resolved = await resolveAppAndWindow(params.appRef);
      if (!resolved) throw producerError("INVALID_APP", "event typing requires app_ref or target");
      ensureForeground(resolved, params.appRef);
      const sim = await inputSim();
      if (target) {
        if (target.kind === "element")
          await invokeAction(() => target.nativeTarget.focus(), "ACTION_UNAVAILABLE");
        else {
          await invokeAction(async () => {
            await prepareCoordinatePointer(sim, target);
            await sim.click(target.nativeTarget);
            rememberCoordinateTarget(target);
          });
        }
      }
      await invokeAction(() => sim.typeText(params.text));
    }
    return completeAction(params, context, target);
  }

  async function semanticElementAction(params, context, action) {
    if (params.target.type !== "element") {
      throw producerError("ACTION_UNAVAILABLE", `${action} requires an element target`);
    }
    const target = await resolveTarget(params.target, params.appRef, context);
    if (params.strategy === "event") {
      throw producerError("ACTION_UNAVAILABLE", `${action} has no event fallback`);
    }
    if (action === "set_value") {
      await invokeAction(() => target.nativeTarget.setValue(params.value), "NOT_SETTABLE");
    } else if (action === "select_text") {
      const value = target.entry.row.value;
      if (params.textRange === undefined && value === null) {
        throw producerError("NOT_SELECTABLE", "element has no text value");
      }
      const [start, length] = params.textRange ?? [0, value.length];
      await invokeAction(
        () => target.nativeTarget.selectText(start, start + length),
        "NOT_SELECTABLE",
      );
    }
    return completeAction(params, context, target);
  }

  async function key(params, context) {
    if (params.strategy === "a11y") {
      throw producerError("ACTION_UNAVAILABLE", "key has no generic accessibility action");
    }
    let resolved;
    let targetResolution;
    if (params.appRef) resolved = await resolveAppAndWindow(params.appRef);
    else {
      targetResolution = await snapshotFor(undefined, context);
      resolved = targetResolution.resolved;
    }
    ensureForeground(resolved, params.appRef);
    const sim = await inputSim();
    for (let count = 0; count < params.repeat; count += 1) {
      if (params.holdSeconds > 0) {
        const pressed = [];
        let failure;
        try {
          for (const held of params.chord.held) {
            await invokeAction(() => sim.keyDown(held));
            pressed.push(held);
          }
          await invokeAction(() => sim.keyDown(params.chord.key));
          pressed.push(params.chord.key);
          await delay(params.holdSeconds * 1000);
        } catch (error) {
          failure = error;
        }
        // keyDown 或首个 keyUp 失败也必须继续释放已按下键，避免把系统留在 Ctrl/Meta 按住状态。
        for (const pressedKey of pressed.toReversed()) {
          try {
            await invokeAction(() => sim.keyUp(pressedKey));
          } catch (error) {
            failure ??= error;
          }
        }
        if (failure) throw failure;
      } else if (params.chord.held.length > 0) {
        await invokeAction(() => sim.chord(params.chord.key, params.chord.held));
      } else {
        await invokeAction(() => sim.press(params.chord.key));
      }
    }
    return completeAction(params, context, targetResolution);
  }

  async function paste(params, context) {
    if (typeof options.paste !== "function") {
      throw producerError("HELPER_UNAVAILABLE", "Helper clipboard paste adapter is unavailable");
    }
    let resolved;
    let targetResolution;
    if (params.appRef) resolved = await resolveAppAndWindow(params.appRef);
    else {
      targetResolution = await snapshotFor(undefined, context);
      resolved = targetResolution.resolved;
    }
    ensureForeground(resolved, params.appRef);
    await invokeAction(
      () => options.paste({ text: params.text, format: params.format, context: context.raw }),
      "INTERNAL",
    );
    return completeAction(params, context, targetResolution);
  }

  async function performAction(params, context) {
    if (params.target.type !== "element") {
      throw producerError("ACTION_UNAVAILABLE", "perform_action requires an element target");
    }
    const target = await resolveTarget(params.target, params.appRef, context);
    if (!target.entry.row.actions.includes(params.action)) {
      throw producerError("ACTION_UNAVAILABLE", "element does not advertise the requested action");
    }
    await invokeAction(
      () => target.nativeTarget.performAction(params.action),
      "ACTION_UNAVAILABLE",
    );
    return completeAction(params, context, target);
  }

  function clearSession(context) {
    snapshots.delete(context.key);
    baselines.delete(context.key);
  }

  async function dispatch(method, rawParams, rawContext) {
    if (disposed) throw producerError("CONTROL_STOPPED", "xa11y producer is disposed");
    if (typeof method !== "string" || !METHOD_NAMES.has(method)) {
      throw producerError("INVALID_REQUEST", "unknown Computer Use method");
    }
    // 参数与 owner context 必须在 native import、权限提示或输入副作用之前完成校验。
    const params = parseParams(method, rawParams);
    const context = parseContext(rawContext);
    switch (method) {
      case "list_apps":
        return listApps();
      case "list_windows":
        return listWindows(params);
      case "get_app_state":
        return getAppState(params, context);
      case "left_click":
        return click(params, context);
      case "left_click_drag":
        return drag(params, context);
      case "scroll":
        return scroll(params, context);
      case "type":
        return typeText(params, context);
      case "set_value":
        return semanticElementAction(params, context, "set_value");
      case "select_text":
        return semanticElementAction(params, context, "select_text");
      case "key":
        return key(params, context);
      case "paste":
        return paste(params, context);
      case "perform_action":
        return performAction(params, context);
      case "request_access":
        if (typeof options.requestAccess !== "function") {
          throw producerError("HELPER_UNAVAILABLE", "Helper permission adapter is unavailable");
        }
        try {
          return await options.requestAccess({
            capabilities: params.capabilities,
            context: context.raw,
          });
        } catch (error) {
          throw mapXa11yError(error, "INTERNAL");
        }
      case "stop_computer_control":
        clearSession(context);
        try {
          await options.stop?.({ reason: params.reason, context: context.raw });
        } catch (error) {
          throw mapXa11yError(error, "INTERNAL");
        }
        return { stopped: true };
      default:
        throw producerError("INVALID_REQUEST", "unknown Computer Use method");
    }
  }

  return {
    dispatch,
    execute(input) {
      const request = requirePlainObject(input, "input");
      requireExactKeys(request, ["method", "params", "context"], "input");
      return dispatch(request.method, request.params, request.context);
    },
    async closeSession(rawContext) {
      if (disposed) return;
      clearSession(parseContext(rawContext));
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      snapshots.clear();
      baselines.clear();
      const sim = await inputSimPromise?.catch(() => undefined);
      await sim?.dispose?.();
    },
  };
}
