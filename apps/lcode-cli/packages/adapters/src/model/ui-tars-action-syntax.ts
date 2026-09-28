export const UI_TARS_COORDINATE_FACTOR = 1_000;

export interface StrictUiTarsActionCall {
  readonly name: string;
  readonly arguments: ReadonlyMap<string, string>;
}

export type UiTarsActionSyntaxFailureCode =
  | "invalid-envelope"
  | "multiple-actions"
  | "unsupported-action"
  | "invalid-arguments"
  | "invalid-coordinate";

export type StrictUiTarsActionSyntaxResult =
  | {
      readonly status: "ok";
      readonly text: string;
      readonly thought: string;
      readonly call: StrictUiTarsActionCall;
    }
  | {
      readonly status: "invalid";
      readonly code: UiTarsActionSyntaxFailureCode;
      readonly message: string;
    };

const SUPPORTED_ACTIONS = new Set([
  "click",
  "left_double",
  "right_single",
  "drag",
  "type",
  "hotkey",
  "scroll",
  "wait",
  "finished",
]);

export function parseStrictUiTarsActionSyntax(textInput: string): StrictUiTarsActionSyntaxResult {
  const text = textInput.trim();
  const actionMarkers = text.match(/Action:/g) ?? [];
  if (actionMarkers.length > 1) {
    return invalid("multiple-actions", "A UI-TARS response must contain exactly one Action");
  }
  if (actionMarkers.length === 0) {
    return invalid("invalid-envelope", "UI-TARS response is missing Action");
  }

  const markerIndex = text.indexOf("Action:");
  if (markerIndex > 0 && text[markerIndex - 1] !== "\n") {
    return invalid("invalid-envelope", "Action must start on its own line");
  }
  const thought = parseThought(text.slice(0, markerIndex));
  if (thought === undefined) {
    return invalid("invalid-envelope", "Only an optional Thought may precede Action");
  }

  const expression = text.slice(markerIndex + "Action:".length).trim();
  if (expression.includes("\n") || expression.includes("\r")) {
    return invalid("invalid-envelope", "Action must be one complete function call");
  }
  const call = parseStrictActionCall(expression);
  if (!call) {
    return invalid("invalid-envelope", "Action is not a complete named function call");
  }
  if (!SUPPORTED_ACTIONS.has(call.name)) {
    return invalid("unsupported-action", `Unsupported UI-TARS action: ${call.name}`);
  }

  const argumentFailure = validateRawArguments(call);
  return argumentFailure ?? { status: "ok", text, thought, call };
}

export function parseUiTarsNormalizedBox(
  value: string,
): readonly [number, number, number, number] | undefined {
  const match =
    /^\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)$/.exec(
      value,
    );
  if (!match) return undefined;
  const box = match.slice(1).map(Number) as [number, number, number, number];
  if (
    !box.every(
      (coordinate) =>
        Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= UI_TARS_COORDINATE_FACTOR,
    ) ||
    box[0] > box[2] ||
    box[1] > box[3]
  ) {
    return undefined;
  }
  return box;
}

function validateRawArguments(
  call: StrictUiTarsActionCall,
): Extract<StrictUiTarsActionSyntaxResult, { status: "invalid" }> | undefined {
  switch (call.name) {
    case "click":
    case "left_double":
    case "right_single":
      return validateBoxes(call, ["start_box"]);
    case "drag":
      return validateBoxes(call, ["start_box", "end_box"]);
    case "scroll": {
      const boxFailure = validateBoxes(call, ["start_box", "direction"]);
      if (boxFailure) return boxFailure;
      const direction = call.arguments.get("direction")?.trim();
      return direction === "up" ||
        direction === "down" ||
        direction === "left" ||
        direction === "right"
        ? undefined
        : invalid("invalid-arguments", "scroll.direction is invalid");
    }
    case "type": {
      if (!hasExactArgumentKeys(call, ["content"])) return invalidArguments(call.name);
      const content = call.arguments.get("content")!;
      return content.length > 0 && !hasUnsafeControlCharacter(content)
        ? undefined
        : invalid("invalid-arguments", "type.content must be a non-empty safe string");
    }
    case "hotkey": {
      if (!hasExactArgumentKeys(call, ["key"])) return invalidArguments(call.name);
      const key = call.arguments.get("key")!.trim();
      return /^[A-Za-z0-9_-]+(?:\+[A-Za-z0-9_-]+)*$/.test(key)
        ? undefined
        : invalid("invalid-arguments", "hotkey.key is not a valid key chord");
    }
    case "wait":
      return hasExactArgumentKeys(call, []) ? undefined : invalidArguments(call.name);
    case "finished": {
      if (!hasExactArgumentKeys(call, []) && !hasExactArgumentKeys(call, ["content"])) {
        return invalidArguments(call.name);
      }
      const content = call.arguments.get("content");
      return content === undefined || !hasUnsafeControlCharacter(content)
        ? undefined
        : invalid("invalid-arguments", "finished.content contains unsupported control characters");
    }
    default:
      return invalid("unsupported-action", `Unsupported UI-TARS action: ${call.name}`);
  }
}

function validateBoxes(
  call: StrictUiTarsActionCall,
  expectedKeys: readonly string[],
): Extract<StrictUiTarsActionSyntaxResult, { status: "invalid" }> | undefined {
  if (!hasExactArgumentKeys(call, expectedKeys)) return invalidArguments(call.name);
  for (const key of expectedKeys.filter((value) => value.endsWith("_box"))) {
    if (!parseUiTarsNormalizedBox(call.arguments.get(key)!)) {
      return invalid("invalid-coordinate", `${call.name}.${key} is not a valid normalized box`);
    }
  }
  return undefined;
}

function parseStrictActionCall(expression: string): StrictUiTarsActionCall | undefined {
  const openParenthesis = expression.indexOf("(");
  if (openParenthesis <= 0 || !expression.endsWith(")")) return undefined;
  const name = expression.slice(0, openParenthesis);
  if (!/^[a-z_]+$/.test(name)) return undefined;
  const argumentsMap = parseStrictArguments(expression.slice(openParenthesis + 1, -1));
  return argumentsMap ? { name, arguments: argumentsMap } : undefined;
}

function parseStrictArguments(source: string): ReadonlyMap<string, string> | undefined {
  const values = new Map<string, string>();
  let cursor = skipSpaces(source, 0);
  if (cursor === source.length) return values;

  while (cursor < source.length) {
    const keyMatch = /^[a-z_][a-z0-9_]*/.exec(source.slice(cursor));
    if (!keyMatch) return undefined;
    const key = keyMatch[0];
    if (values.has(key)) return undefined;
    cursor = skipSpaces(source, cursor + key.length);
    if (source[cursor] !== "=") return undefined;
    cursor = skipSpaces(source, cursor + 1);
    if (source[cursor] !== "'") return undefined;
    cursor += 1;

    let value = "";
    let closed = false;
    while (cursor < source.length) {
      const character = source[cursor]!;
      if (character === "'") {
        closed = true;
        cursor += 1;
        break;
      }
      if (character === "\\") {
        const next = source[cursor + 1];
        // 上游 parser 不支持转义单引号；先拒绝，避免它截断后仍产出可执行动作。
        if (next === undefined || next === "'") return undefined;
        value += character + next;
        cursor += 2;
        continue;
      }
      if (character === "\n" || character === "\r") return undefined;
      value += character;
      cursor += 1;
    }
    if (!closed) return undefined;
    values.set(key, value);

    cursor = skipSpaces(source, cursor);
    if (cursor === source.length) return values;
    if (source[cursor] !== ",") return undefined;
    cursor = skipSpaces(source, cursor + 1);
    if (cursor === source.length) return undefined;
  }
  return values;
}

function parseThought(prefix: string): string | undefined {
  const trimmed = prefix.trim();
  if (trimmed === "") return "";
  const match = /^Thought:(?:[ \t]+([\s\S]*))?$/.exec(trimmed);
  return match ? (match[1] ?? "").trim() : undefined;
}

function hasExactArgumentKeys(call: StrictUiTarsActionCall, expected: readonly string[]): boolean {
  return sameKeys([...call.arguments.keys()], expected);
}

function sameKeys(actual: readonly string[], expected: readonly string[]): boolean {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  return (
    actualSorted.length === expectedSorted.length &&
    actualSorted.every((value, index) => value === expectedSorted[index])
  );
}

function skipSpaces(value: string, start: number): number {
  let cursor = start;
  while (value[cursor] === " " || value[cursor] === "\t") cursor += 1;
  return cursor;
}

function hasUnsafeControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 8 || (code >= 11 && code <= 12) || (code >= 14 && code <= 31) || code === 127) {
      return true;
    }
  }
  return false;
}

function invalid(
  code: UiTarsActionSyntaxFailureCode,
  message: string,
): Extract<StrictUiTarsActionSyntaxResult, { status: "invalid" }> {
  return { status: "invalid", code, message };
}

function invalidArguments(
  action: string,
): Extract<StrictUiTarsActionSyntaxResult, { status: "invalid" }> {
  return invalid("invalid-arguments", `${action} arguments do not match the UI-TARS contract`);
}
