export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function summarizeInput(input: unknown): Record<string, unknown> {
  if (input === null) return { type: "null" };
  if (Array.isArray(input)) return { type: "array", length: input.length };
  if (typeof input === "object") {
    return {
      type: "object",
      keys: Object.keys(input as Record<string, unknown>).slice(0, 20),
    };
  }
  if (typeof input === "string") return { type: "string", length: input.length };
  return { type: typeof input };
}

export function previewHookValue(value: unknown): string {
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    if (!serialized) return "";
    return serialized.length <= 4000 ? serialized : `${serialized.slice(0, 4000)}...[truncated]`;
  } catch {
    return String(value);
  }
}
