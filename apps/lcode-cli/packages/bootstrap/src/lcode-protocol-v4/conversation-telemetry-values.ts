import type { SessionEvent } from "@lcode/contracts";

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function eventTimestamp(event: SessionEvent): number {
  const value =
    event.timestamp instanceof Date ? event.timestamp.getTime() : Number(event.timestamp);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function streamingParentToolCallId(payload: Record<string, unknown>): string | undefined {
  const meta = recordValue(payload._meta);
  const lcode = recordValue(meta.lcode);
  return (
    optionalString(payload.parentToolCallId) ??
    optionalString(payload.parentToolUseId) ??
    optionalString(meta.parentToolCallId) ??
    optionalString(meta.parentToolUseId) ??
    optionalString(lcode.parentToolCallId) ??
    optionalString(lcode.parentToolUseId)
  );
}
