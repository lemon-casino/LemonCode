// 驱动 seam 的类型面。内部模块：不进 package.json exports；nut-js 类型不跨包泄漏。
export interface CuaDriverPoint {
  x: number;
  y: number;
}

export interface CuaDriverScreenshot {
  /** PNG 字节的 base64。 */
  data: string;
  mimeType: "image/png";
  width: number;
  height: number;
}

export type CuaDriverButton = "left" | "right" | "middle";

export interface CuaDriverClickInput {
  x: number;
  y: number;
  button: CuaDriverButton;
}

export interface CuaDriverDragInput {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  button: CuaDriverButton;
}

export interface CuaDriverTypeInput {
  text: string;
}

export interface CuaDriverKeyInput {
  /** wire 键名（spec「动作入参契约」词表），由驱动映射到 nut-js Key。 */
  key: string;
}

export interface CuaDriverScrollInput {
  direction: "up" | "down" | "left" | "right";
  /** 滚轮步数（>0），单步实际距离 OS 相关。 */
  amount: number;
}

export interface CuaInputDriver {
  screenshot(): Promise<CuaDriverScreenshot>;
  move(input: CuaDriverPoint): Promise<void>;
  click(input: CuaDriverClickInput): Promise<void>;
  doubleClick(input: CuaDriverClickInput): Promise<void>;
  drag(input: CuaDriverDragInput): Promise<void>;
  type(input: CuaDriverTypeInput): Promise<void>;
  key(input: CuaDriverKeyInput): Promise<void>;
  scroll(input: CuaDriverScrollInput): Promise<void>;
  dispose(): Promise<void>;
}

/** 解析 wire 键名为 nut-js Key 枚举属性名；未知键名返回 undefined。 */
export declare function resolveNutKeyName(name: string): string | undefined;

/** 由逻辑屏幕尺寸与物理光栅尺寸计算指针换算比例；非法输入退回 1:1。 */
export declare function computePointerScale(
  logicalWidth: number,
  logicalHeight: number,
  rasterWidth: number,
  rasterHeight: number,
): CuaDriverPoint;

/** 光栅像素坐标 → nut-js 逻辑屏幕坐标（四舍五入到整像素）。 */
export declare function toLogicalPoint(scale: CuaDriverPoint, x: number, y: number): CuaDriverPoint;

/** 默认 nut-js 驱动；内部动态 import，失败按驱动异常上抛。 */
export declare function createNutJsDriver(): CuaInputDriver;
