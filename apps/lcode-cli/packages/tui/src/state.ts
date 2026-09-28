import type { SessionEvent } from "@lcode/contracts";
import type { TuiPromptInput } from "./types.js";

export const normalizePromptInput = (
  input: TuiPromptInput,
): { text: string; attachmentCount: number } => {
  if (typeof input === "string") {
    return {
      attachmentCount: 0,
      text: input,
    };
  }

  return {
    attachmentCount: input.attachments?.length ?? 0,
    text: input.text,
  };
};

export const describeSessionEvent = (event: SessionEvent): string => {
  if (typeof event !== "object" || event === null) return "session event";
  const type = "type" in event && typeof event.type === "string" ? event.type : "session event";
  return type.replaceAll("_", " ");
};

export const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

export const stringField = (
  value: Record<string, unknown>,
  key: string,
): string | undefined => {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
};

export const numberField = (
  value: Record<string, unknown>,
  key: string,
): number | undefined => {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
};

export const booleanField = (
  value: Record<string, unknown>,
  key: string,
): boolean | undefined => {
  const field = value[key];
  return typeof field === "boolean" ? field : undefined;
};

export const formatNumber = (value: number): string => value.toLocaleString("en-US");

export const formatDuration = (durationMs: number | undefined): string => {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return "-";
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  return `${Math.round(durationMs / 1_000)}s`;
};

export const truncatePlain = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, Math.max(0, maxLength));
  return `${value.slice(0, maxLength - 3)}...`;
};

export const matchesText = (query: string, values: Array<string | undefined>): boolean => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return values.some((value) => value?.toLowerCase().includes(normalized));
};
