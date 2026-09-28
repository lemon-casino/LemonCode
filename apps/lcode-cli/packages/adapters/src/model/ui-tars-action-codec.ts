import { actionParser } from "@ui-tars/action-parser";
import {
  UI_TARS_COORDINATE_FACTOR,
  parseStrictUiTarsActionSyntax,
  parseUiTarsNormalizedBox,
  type StrictUiTarsActionCall,
  type UiTarsActionSyntaxFailureCode,
} from "./ui-tars-action-syntax.js";

export const UI_TARS_SCROLL_AMOUNT = 1;
export const UI_TARS_WAIT_DURATION_MS = 500;

export interface UiTarsFrameSize {
  readonly width: number;
  readonly height: number;
}

export interface DecodeUiTarsTextActionInput {
  readonly text: string;
  readonly frame: UiTarsFrameSize;
  /** 原生 tool call 与文本动作同时存在时必须整段拒绝，不能选择其中一条执行。 */
  readonly hasNativeToolCalls?: boolean;
}

export type UiTarsNormalizedAction =
  | {
      readonly name: "left_click";
      readonly parameters: {
        readonly x: number;
        readonly y: number;
        readonly mouse_button: "left" | "right";
        readonly click_count: 1 | 2;
      };
    }
  | {
      readonly name: "left_click_drag";
      readonly parameters: {
        readonly start_x: number;
        readonly start_y: number;
        readonly end_x: number;
        readonly end_y: number;
      };
    }
  | { readonly name: "type"; readonly parameters: { readonly content: string } }
  | { readonly name: "key"; readonly parameters: { readonly key: string } }
  | {
      readonly name: "scroll";
      readonly parameters: {
        readonly x: number;
        readonly y: number;
        readonly direction: "up" | "down" | "left" | "right";
        readonly scroll_amount: typeof UI_TARS_SCROLL_AMOUNT;
      };
    }
  | {
      readonly name: "wait";
      readonly parameters: { readonly duration_ms: typeof UI_TARS_WAIT_DURATION_MS };
    };

export type UiTarsDecision =
  | {
      readonly kind: "action";
      readonly thought: string;
      readonly action: UiTarsNormalizedAction;
    }
  | { readonly kind: "finished"; readonly thought: string; readonly content: string };

export type UiTarsActionCodecFailureCode =
  | "invalid-frame"
  | "native-tool-call-conflict"
  | UiTarsActionSyntaxFailureCode
  | "parser-mismatch";

export type UiTarsActionCodecResult =
  | { readonly status: "ok"; readonly decision: UiTarsDecision }
  | {
      readonly status: "invalid";
      readonly code: UiTarsActionCodecFailureCode;
      readonly message: string;
    };

type ParsedActionInputs = Record<string, unknown>;
type CodecFailure = Extract<UiTarsActionCodecResult, { status: "invalid" }>;

/**
 * 把一条完整 UI-TARS 文本响应解析为纯数据 decision。函数不执行工具，也不返回部分动作。
 */
export function decodeUiTarsTextAction(
  input: DecodeUiTarsTextActionInput,
): UiTarsActionCodecResult {
  if (!isValidFrame(input.frame)) {
    return invalid("invalid-frame", "UI-TARS decoding requires a positive integer frame size");
  }
  if (input.hasNativeToolCalls) {
    return invalid(
      "native-tool-call-conflict",
      "A UI-TARS text action cannot be combined with native tool calls",
    );
  }

  const syntax = parseStrictUiTarsActionSyntax(input.text);
  if (syntax.status === "invalid") return syntax;
  const { call, text, thought } = syntax;

  let parsedResult: ReturnType<typeof actionParser>;
  try {
    parsedResult = actionParser({
      prediction: text,
      factor: [UI_TARS_COORDINATE_FACTOR, UI_TARS_COORDINATE_FACTOR],
      screenContext: input.frame,
      mode: "bc",
    });
  } catch {
    return invalid("parser-mismatch", "UI-TARS parser rejected the validated action");
  }

  if (parsedResult.parsed.length !== 1) {
    return invalid("parser-mismatch", "UI-TARS parser did not produce exactly one action");
  }
  const parsed = parsedResult.parsed[0]!;
  if (
    parsed.action_type !== call.name ||
    parsed.reflection !== null ||
    parsed.thought !== thought
  ) {
    return invalid("parser-mismatch", "UI-TARS parser output does not match the strict envelope");
  }

  return normalizeDecision(call, parsed.action_inputs as ParsedActionInputs, thought, input.frame);
}

function normalizeDecision(
  call: StrictUiTarsActionCall,
  inputs: ParsedActionInputs,
  thought: string,
  frame: UiTarsFrameSize,
): UiTarsActionCodecResult {
  switch (call.name) {
    case "click":
    case "left_double":
    case "right_single": {
      if (!hasExactKeys(inputs, ["start_box", "start_coords"])) return parserMismatch();
      const point = readParserPoint(call, inputs, "start", frame);
      if (!point) return invalid("invalid-coordinate", "UI-TARS click coordinates are invalid");
      return success(thought, {
        name: "left_click",
        parameters: {
          x: point[0],
          y: point[1],
          mouse_button: call.name === "right_single" ? "right" : "left",
          click_count: call.name === "left_double" ? 2 : 1,
        },
      });
    }
    case "drag": {
      if (!hasExactKeys(inputs, ["start_box", "start_coords", "end_box", "end_coords"])) {
        return parserMismatch();
      }
      const start = readParserPoint(call, inputs, "start", frame);
      const end = readParserPoint(call, inputs, "end", frame);
      if (!start || !end) {
        return invalid("invalid-coordinate", "UI-TARS drag coordinates are invalid");
      }
      return success(thought, {
        name: "left_click_drag",
        parameters: {
          start_x: start[0],
          start_y: start[1],
          end_x: end[0],
          end_y: end[1],
        },
      });
    }
    case "type": {
      if (!hasExactKeys(inputs, ["content"]) || !parserScalarMatches(call, inputs, "content")) {
        return parserMismatch();
      }
      return success(thought, {
        name: "type",
        parameters: { content: call.arguments.get("content")! },
      });
    }
    case "hotkey": {
      if (!hasExactKeys(inputs, ["key"]) || !parserScalarMatches(call, inputs, "key")) {
        return parserMismatch();
      }
      return success(thought, {
        name: "key",
        parameters: { key: call.arguments.get("key")!.trim() },
      });
    }
    case "scroll": {
      if (
        !hasExactKeys(inputs, ["start_box", "start_coords", "direction"]) ||
        !parserScalarMatches(call, inputs, "direction")
      ) {
        return parserMismatch();
      }
      const point = readParserPoint(call, inputs, "start", frame);
      if (!point) return invalid("invalid-coordinate", "UI-TARS scroll coordinates are invalid");
      return success(thought, {
        name: "scroll",
        parameters: {
          x: point[0],
          y: point[1],
          direction: call.arguments.get("direction")!.trim() as "up" | "down" | "left" | "right",
          scroll_amount: UI_TARS_SCROLL_AMOUNT,
        },
      });
    }
    case "wait":
      if (!hasExactKeys(inputs, [])) return parserMismatch();
      return success(thought, {
        name: "wait",
        parameters: { duration_ms: UI_TARS_WAIT_DURATION_MS },
      });
    case "finished": {
      const content = call.arguments.get("content") ?? "";
      const parserDropsExplicitEmptyContent = call.arguments.has("content") && content === "";
      if (
        !hasExactKeys(
          inputs,
          call.arguments.has("content") && !parserDropsExplicitEmptyContent ? ["content"] : [],
        ) ||
        (call.arguments.has("content") &&
          !parserDropsExplicitEmptyContent &&
          !parserScalarMatches(call, inputs, "content"))
      ) {
        return parserMismatch();
      }
      return { status: "ok", decision: { kind: "finished", thought, content } };
    }
    default:
      return invalid("unsupported-action", `Unsupported UI-TARS action: ${call.name}`);
  }
}

function readParserPoint(
  call: StrictUiTarsActionCall,
  inputs: ParsedActionInputs,
  prefix: "start" | "end",
  frame: UiTarsFrameSize,
): readonly [number, number] | undefined {
  const boxKey = `${prefix}_box`;
  const coordsKey = `${prefix}_coords`;
  const box = parseUiTarsNormalizedBox(call.arguments.get(boxKey)!);
  const parsedBox = parseParserBox(inputs[boxKey]);
  const coords = inputs[coordsKey];
  if (!box || !parsedBox || !Array.isArray(coords) || coords.length !== 2) return undefined;

  const normalized = box.map((value) => value / UI_TARS_COORDINATE_FACTOR);
  if (!normalized.every((value, index) => value === parsedBox[index])) return undefined;
  if (!coords.every((value) => typeof value === "number" && Number.isFinite(value))) {
    return undefined;
  }

  const expectedX = roundParserCoordinate(
    ((box[0] + box[2]) / 2 / UI_TARS_COORDINATE_FACTOR) * frame.width,
  );
  const expectedY = roundParserCoordinate(
    ((box[1] + box[3]) / 2 / UI_TARS_COORDINATE_FACTOR) * frame.height,
  );
  if (coords[0] !== expectedX || coords[1] !== expectedY) return undefined;

  const x = Math.round(coords[0]);
  const y = Math.round(coords[1]);
  return x >= 0 && x < frame.width && y >= 0 && y < frame.height ? [x, y] : undefined;
}

function parseParserBox(value: unknown): readonly number[] | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.length === 4 && parsed.every(Number.isFinite)
      ? (parsed as number[])
      : undefined;
  } catch {
    return undefined;
  }
}

function parserScalarMatches(
  call: StrictUiTarsActionCall,
  inputs: ParsedActionInputs,
  key: string,
): boolean {
  return inputs[key] === call.arguments.get(key)?.trim();
}

function hasExactKeys(input: ParsedActionInputs, expected: readonly string[]): boolean {
  return sameKeys(Object.keys(input), expected);
}

function sameKeys(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    [...actual].sort().every((value, index) => value === [...expected].sort()[index])
  );
}

function roundParserCoordinate(value: number): number {
  return Math.round(value * UI_TARS_COORDINATE_FACTOR) / UI_TARS_COORDINATE_FACTOR;
}

function isValidFrame(frame: UiTarsFrameSize): boolean {
  return (
    Number.isInteger(frame.width) &&
    frame.width > 0 &&
    Number.isInteger(frame.height) &&
    frame.height > 0
  );
}

function success(thought: string, action: UiTarsNormalizedAction): UiTarsActionCodecResult {
  return { status: "ok", decision: { kind: "action", thought, action } };
}

function invalid(code: UiTarsActionCodecFailureCode, message: string): CodecFailure {
  return { status: "invalid", code, message };
}

function parserMismatch(): CodecFailure {
  return invalid("parser-mismatch", "UI-TARS parser output does not match the strict action");
}
