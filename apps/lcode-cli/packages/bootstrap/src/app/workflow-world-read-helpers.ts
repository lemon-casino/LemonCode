/** stderr / stdout 的首行（错误消息用，不回显整段输出）。 */
export function firstLine(text: string): string {
  return text.split("\n", 1)[0]?.trim() ?? "";
}

/** 实参形状的简短描述（只用于错误消息，不回显完整内容）。 */
export function describeArg(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}
