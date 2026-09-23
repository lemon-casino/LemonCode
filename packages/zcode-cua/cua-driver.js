// 本地输入驱动 seam 的默认实现：@nut-tree-fork/nut-js。
// 约束：
// - nut-js 只允许出现在本文件（动态 import，类型不跨包泄漏；desktop bundle 经 tsup external
//   保持外部化，见 specs/computer-use-open-replacement.md 打包接线约束）。
// - import 失败 / 原生 addon 缺失按驱动异常上抛，由 runtime 归一为占位失败形状，进程不 crash。
// - DPI：nut-js 指针走逻辑屏幕坐标，screen.grab() 返回物理像素光栅；指针入参按最近一次
//   screenshot 的光栅坐标解释，此处换算为逻辑坐标（真机证据：Windows 150% 缩放下
//   screen.width()=1707x960 而 grab()=2560x1440）。
import { encodeRgbPng } from "./png.js";

const BUTTON_BY_NAME = { left: "LEFT", right: "RIGHT", middle: "MIDDLE" };

const SCROLL_METHOD_BY_DIRECTION = {
  up: "scrollUp",
  down: "scrollDown",
  left: "scrollLeft",
  right: "scrollRight",
};

// wire 键名 → nut-js Key 枚举属性。字母/数字/功能键按规则映射，其余具名列出。
const NAMED_KEYS = {
  enter: "Enter",
  tab: "Tab",
  escape: "Escape",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  minus: "Minus",
  equal: "Equal",
  grave: "Grave",
  comma: "Comma",
  period: "Period",
  slash: "Slash",
  semicolon: "Semicolon",
  quote: "Quote",
  leftbracket: "LeftBracket",
  rightbracket: "RightBracket",
  backslash: "Backslash",
  capslock: "CapsLock",
  numlock: "NumLock",
  print: "Print",
  scrolllock: "ScrollLock",
  pause: "Pause",
};

/**
 * 解析 wire 键名为 nut-js Key 枚举属性名；未知键名返回 undefined（由调用方按驱动异常处理）。
 * 词表大小写敏感（spec 入参契约：键名是小写词表，大写/混合取值非法）。
 * 纯函数，供包内单测直接覆盖词表。
 */
export function resolveNutKeyName(name) {
  if (typeof name !== "string" || name.length === 0) return undefined;
  const named = NAMED_KEYS[name];
  if (named) return named;
  if (/^[a-z]$/.test(name)) return name.toUpperCase();
  if (/^[0-9]$/.test(name)) return `Num${name}`;
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(name)) return name.toUpperCase();
  return undefined;
}

/**
 * 由一次截图同时给出的逻辑屏幕尺寸与物理光栅尺寸计算指针换算比例。
 * 尺寸非法（≤0）时退回 1:1，绝不抛错——换算失败不应放大成动作失败。
 */
export function computePointerScale(logicalWidth, logicalHeight, rasterWidth, rasterHeight) {
  if (
    !Number.isFinite(logicalWidth) ||
    !Number.isFinite(logicalHeight) ||
    !Number.isFinite(rasterWidth) ||
    !Number.isFinite(rasterHeight) ||
    logicalWidth <= 0 ||
    logicalHeight <= 0 ||
    rasterWidth <= 0 ||
    rasterHeight <= 0
  ) {
    return { x: 1, y: 1 };
  }
  return { x: logicalWidth / rasterWidth, y: logicalHeight / rasterHeight };
}

/** 光栅像素坐标 → nut-js 逻辑屏幕坐标（四舍五入到整像素）。 */
export function toLogicalPoint(scale, x, y) {
  return { x: Math.round(x * scale.x), y: Math.round(y * scale.y) };
}

// nut-js 内存帧是 BGR(A) 行主序原始缓冲；统一转成 PNG 用的 RGB（丢弃 alpha/填充位）。
function imageToRgbBuffer(image) {
  const width = image.width;
  const height = image.height;
  const channels = image.channels >= 3 ? image.channels : 3;
  // byteWidth 是行步长（可能含行尾填充），不能假设等于 width*channels。
  const stride = image.byteWidth > 0 ? image.byteWidth : width * channels;
  const data = image.data;
  // ColorMode 枚举：BGR=0、RGB=1；按数值比较，避免跨 enum 对象引用。
  const swapRedBlue = image.colorMode === 0;
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    let src = y * stride;
    let dst = y * width * 3;
    for (let x = 0; x < width; x += 1) {
      const first = data[src];
      const green = data[src + 1];
      const last = data[src + 2];
      rgb[dst] = swapRedBlue ? last : first;
      rgb[dst + 1] = green;
      rgb[dst + 2] = swapRedBlue ? first : last;
      src += channels;
      dst += 3;
    }
  }
  return rgb;
}

export function createNutJsDriver() {
  // 指针换算比例只由本 driver 的 screenshot 更新；分辨率热切换在下一次截图前是已知陈旧窗口。
  let pointerScale = { x: 1, y: 1 };
  // 动态 import 失败不能永久钉死 driver：清空缓存，允许下一次调用重试。
  let modulePromise;
  const loadNutJs = async () => {
    modulePromise ??= import("@nut-tree-fork/nut-js");
    try {
      return await modulePromise;
    } catch (error) {
      modulePromise = undefined;
      throw error;
    }
  };

  async function screenshot() {
    const nut = await loadNutJs();
    const [image, logicalWidth, logicalHeight] = await Promise.all([
      nut.screen.grab(),
      nut.screen.width(),
      nut.screen.height(),
    ]);
    pointerScale = computePointerScale(logicalWidth, logicalHeight, image.width, image.height);
    const png = encodeRgbPng(image.width, image.height, imageToRgbBuffer(image));
    return {
      data: png.toString("base64"),
      mimeType: "image/png",
      width: image.width,
      height: image.height,
    };
  }

  function resolveButton(nut, name) {
    const value = nut.Button?.[BUTTON_BY_NAME[name]];
    if (value === undefined)
      throw new Error(`Computer Use driver received an unknown button: ${name}`);
    return value;
  }

  function toPoint(nut, logical) {
    return new nut.Point(logical.x, logical.y);
  }

  async function move(input) {
    const nut = await loadNutJs();
    await nut.mouse.setPosition(toPoint(nut, toLogicalPoint(pointerScale, input.x, input.y)));
  }

  async function click(input) {
    const nut = await loadNutJs();
    const button = resolveButton(nut, input.button);
    await nut.mouse.setPosition(toPoint(nut, toLogicalPoint(pointerScale, input.x, input.y)));
    await nut.mouse.click(button);
  }

  async function doubleClick(input) {
    const nut = await loadNutJs();
    const button = resolveButton(nut, input.button);
    await nut.mouse.setPosition(toPoint(nut, toLogicalPoint(pointerScale, input.x, input.y)));
    await nut.mouse.doubleClick(button);
  }

  async function drag(input) {
    const nut = await loadNutJs();
    // nut-js 的 mouse.drag() 固定左键且带平滑轨迹；这里用按住-移动-松开组装任意键拖拽，
    // setPosition 是瞬移（不走 mouseSpeed 动画），finally 确保按钮不会被卡在按下态。
    const button = resolveButton(nut, input.button);
    await nut.mouse.setPosition(
      toPoint(nut, toLogicalPoint(pointerScale, input.fromX, input.fromY)),
    );
    await nut.mouse.pressButton(button);
    try {
      await nut.mouse.setPosition(toPoint(nut, toLogicalPoint(pointerScale, input.toX, input.toY)));
    } finally {
      await nut.mouse.releaseButton(button);
    }
  }

  async function type(input) {
    const nut = await loadNutJs();
    await nut.keyboard.type(input.text);
  }

  async function key(input) {
    const nut = await loadNutJs();
    const keyName = resolveNutKeyName(input.key);
    if (!keyName) throw new Error(`Computer Use driver received an unknown key: ${input.key}`);
    // nut-js 4.2.6 的 KeyboardClass 没有 tap 方法（只有 type/pressKey/releaseKey）；
    // type(Key) 对 Key 输入走原生 click()（按下+释放），即单键 tap 语义。
    await nut.keyboard.type(nut.Key[keyName]);
  }

  async function scroll(input) {
    const nut = await loadNutJs();
    const method = SCROLL_METHOD_BY_DIRECTION[input.direction];
    // amount 的「步」实际距离由 OS 决定（nut-js 语义），这里不做像素换算。
    await nut.mouse[method](input.amount);
  }

  async function dispose() {
    // nut-js 的 mouse/keyboard/screen 是模块级单例，无可释放的 driver 级句柄；
    // 重置换算比例即可，下一次使用从 1:1 重新校准。
    pointerScale = { x: 1, y: 1 };
  }

  return { screenshot, move, click, doubleClick, drag, type, key, scroll, dispose };
}
