import type { BrowserKeyModifier, BrowserMouseButton } from "@lcode/shared";
import { RESOLVE_SCRIPT } from "./browserCommandScripts.js";
import type { BrowserPoint, ControlledView } from "./browserCommandTypes.js";

/**
 * 键盘修饰键 → CDP modifiers 位掩码（Alt=1, Control=2, Meta=4, Shift=8）。
 * click/press/drag 均复用此映射，透传给 dispatchMouseEvent/dispatchKeyEvent。
 */
const MODIFIER_BITS: Record<BrowserKeyModifier, number> = {
  Alt: 1,
  Control: 2,
  ControlOrMeta: process.platform === "darwin" ? 4 : 2,
  Meta: 4,
  Shift: 8,
};

/**
 * 常用键名 → CDP Input.dispatchKeyEvent 参数映射。
 * 未命中的 key 走裸传（仅带 key 字段），交给内核尽力解释。
 */
const KEY_MAP: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
};

const MODIFIER_KEY_MAP: Record<
  BrowserKeyModifier,
  { code: string; windowsVirtualKeyCode: number }
> = {
  Alt: { code: "AltLeft", windowsVirtualKeyCode: 18 },
  Control: { code: "ControlLeft", windowsVirtualKeyCode: 17 },
  ControlOrMeta:
    process.platform === "darwin"
      ? { code: "MetaLeft", windowsVirtualKeyCode: 91 }
      : { code: "ControlLeft", windowsVirtualKeyCode: 17 },
  Meta: { code: "MetaLeft", windowsVirtualKeyCode: 91 },
  Shift: { code: "ShiftLeft", windowsVirtualKeyCode: 16 },
};

function normalizeCuaKey(raw: string): string {
  const key = raw.trim();
  const alias: Record<string, string> = {
    alt: "Alt",
    option: "Alt",
    control: "Control",
    ctrl: "Control",
    controlormeta: process.platform === "darwin" ? "Meta" : "Control",
    cmd: "Meta",
    meta: "Meta",
    super: "Meta",
    win: "Meta",
    shift: "Shift",
    esc: "Escape",
    return: "Enter",
    space: "Space",
    left: "ArrowLeft",
    right: "ArrowRight",
    up: "ArrowUp",
    down: "ArrowDown",
  };
  return alias[key.toLowerCase()] ?? key;
}

function asModifier(key: string): BrowserKeyModifier | undefined {
  return ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"].includes(key)
    ? (key as BrowserKeyModifier)
    : undefined;
}

function keyDefinition(keyName: string): {
  key: string;
  code?: string;
  windowsVirtualKeyCode?: number;
} {
  const known = KEY_MAP[keyName];
  if (known) return known;
  const modifier = asModifier(keyName);
  if (modifier) return { key: modifier, ...MODIFIER_KEY_MAP[modifier] };
  if (/^[a-z]$/iu.test(keyName)) {
    const upper = keyName.toUpperCase();
    return { key: keyName, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0) };
  }
  if (/^[0-9]$/u.test(keyName)) {
    return {
      key: keyName,
      code: `Digit${keyName}`,
      windowsVirtualKeyCode: keyName.charCodeAt(0),
    };
  }
  return { key: keyName };
}

export function modifiersBitmask(mods?: readonly BrowserKeyModifier[]): number {
  if (!mods || mods.length === 0) return 0;
  let bits = 0;
  for (const m of mods) bits |= MODIFIER_BITS[m];
  return bits;
}

/** 解析 ref 元素中心坐标；未找到（含返回非法结构）→ null。 */
export async function resolveRefCenter(
  view: ControlledView,
  ref: string,
): Promise<BrowserPoint | null> {
  const raw = (await view.webContents.executeJavaScript(RESOLVE_SCRIPT(ref))) as {
    cx?: unknown;
    cy?: unknown;
  } | null;
  if (!raw || typeof raw.cx !== "number" || typeof raw.cy !== "number") return null;
  return { cx: raw.cx, cy: raw.cy };
}

/** 在给定坐标发一次 CDP 真实鼠标点击（mouseMoved→mousePressed→mouseReleased）。 */
export async function dispatchClickAt(
  view: ControlledView,
  center: BrowserPoint,
  button: BrowserMouseButton,
  doubleClick: boolean,
  modifiers = 0,
): Promise<void> {
  const clickCount = doubleClick ? 2 : 1;
  // modifiers=0 时不带该字段，保持与既有单测（不含 modifiers 的断言）一致。
  const mod = modifiers > 0 ? { modifiers } : {};
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: center.cx,
    y: center.cy,
    ...mod,
  });
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: center.cx,
    y: center.cy,
    button,
    clickCount,
    ...mod,
  });
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: center.cx,
    y: center.cy,
    button,
    clickCount,
    ...mod,
  });
}

/**
 * 从起点拖到终点：mousePressed@from → 多个插值 mouseMoved → mouseReleased@to（带 modifiers）。
 * 拖拽期间的 mouseMoved 带 buttons:1（左键按住位）以让内核识别为拖拽而非普通移动。
 */
export async function dispatchDrag(
  view: ControlledView,
  from: BrowserPoint,
  to: BrowserPoint,
  modifiers = 0,
): Promise<void> {
  const mod = modifiers > 0 ? { modifiers } : {};
  const STEPS = 10;
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: from.cx,
    y: from.cy,
    ...mod,
  });
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: from.cx,
    y: from.cy,
    button: "left",
    clickCount: 1,
    ...mod,
  });
  for (let i = 1; i <= STEPS; i++) {
    const x = Math.round(from.cx + ((to.cx - from.cx) * i) / STEPS);
    const y = Math.round(from.cy + ((to.cy - from.cy) * i) / STEPS);
    await view.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "left",
      buttons: 1,
      ...mod,
    });
  }
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: to.cx,
    y: to.cy,
    button: "left",
    clickCount: 1,
    ...mod,
  });
}

/** Drag 输入：逐点保留调用方 path，不把手绘/曲线路径重建为首尾直线。 */
export async function dispatchDragPath(
  view: ControlledView,
  path: readonly { x: number; y: number }[],
  modifiers = 0,
): Promise<void> {
  const [first, ...rest] = path;
  if (!first) throw new Error("cua_drag requires a non-empty path");
  const mod = modifiers > 0 ? { modifiers } : {};
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: first.x,
    y: first.y,
    ...mod,
  });
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: first.x,
    y: first.y,
    button: "left",
    clickCount: 1,
    ...mod,
  });
  let last = first;
  try {
    for (const point of rest) {
      last = point;
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 1,
        ...mod,
      });
    }
  } finally {
    await view.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: last.x,
      y: last.y,
      button: "left",
      clickCount: 1,
      ...mod,
    });
  }
}

/** CUA scroll：先移动到锚点，再从该位置发送真实滚轮输入。 */
export async function dispatchScrollGesture(
  view: ControlledView,
  point: BrowserPoint,
  scrollX: number,
  scrollY: number,
  modifiers = 0,
): Promise<void> {
  const mod = modifiers > 0 ? { modifiers } : {};
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.cx,
    y: point.cy,
    ...mod,
  });
  // Electron 41 / Chromium 146 的 <webview> guest 会让
  // Input.synthesizeScrollGesture 静默成功但不产生 wheel 事件，页面因此完全不滚动。
  // mouseWheel 仍是命中锚点的 trusted input，可保留嵌套滚动区和 wheel handler 语义。
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: point.cx,
    y: point.cy,
    deltaX: scrollX,
    deltaY: scrollY,
    ...mod,
  });
}

/** 组合键输入：逐键按下组合键，末键 down/up 后逆序释放其余按键。 */
export async function dispatchKeyPress(
  view: ControlledView,
  keys: readonly string[],
): Promise<void> {
  const normalized = keys
    .flatMap((key) => key.split("+"))
    .filter(Boolean)
    .map(normalizeCuaKey);
  const last = normalized.at(-1);
  if (!last) throw new Error("keypress requires at least one key");
  const held = normalized.slice(0, -1);
  const pressedModifiers = new Set<BrowserKeyModifier>();

  const dispatch = async (type: "keyDown" | "keyUp", keyName: string): Promise<void> => {
    const modifier = asModifier(keyName);
    if (type === "keyDown" && modifier) pressedModifiers.add(modifier);
    if (type === "keyUp" && modifier) pressedModifiers.delete(modifier);
    const definition = keyDefinition(keyName);
    const modifiers = modifiersBitmask([...pressedModifiers]);
    await view.cdp.send("Input.dispatchKeyEvent", {
      type,
      ...definition,
      ...(modifiers > 0 ? { modifiers } : {}),
    });
  };

  for (const key of held) await dispatch("keyDown", key);
  await dispatch("keyDown", last);
  await dispatch("keyUp", last);
  for (const key of held.toReversed()) await dispatch("keyUp", key);
}

/** 发一次按键（keyDown + keyUp）；已知键带完整映射，未知键裸传 key。modifiers 位掩码可透传。 */
export async function dispatchKey(
  view: ControlledView,
  keyName: string,
  modifiers = 0,
  sessionId?: string,
): Promise<void> {
  const def = KEY_MAP[keyName];
  const base = def
    ? { key: def.key, code: def.code, windowsVirtualKeyCode: def.windowsVirtualKeyCode }
    : { key: keyName };
  // modifiers=0 时不带该字段，保持与既有单测（不含 modifiers 的断言）一致。
  const mod = modifiers > 0 ? { modifiers } : {};
  const sendKey = (type: "keyDown" | "keyUp") =>
    sessionId == null
      ? view.cdp.send("Input.dispatchKeyEvent", { type, ...base, ...mod })
      : view.cdp.send("Input.dispatchKeyEvent", { type, ...base, ...mod }, sessionId);
  await sendKey("keyDown");
  await sendKey("keyUp");
}
