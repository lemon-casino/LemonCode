import type { LCodeStreamingToolInputState } from "./streaming-tool-input-preview.js";

export interface LCodeToolProjectionMemory {
  completeToolInputById?: Map<string, unknown>;
  streamingToolInputById?: Map<string, LCodeStreamingToolInputState>;
  toolNameById?: Map<string, string>;
}

export interface LCodeToolProjectionMetadata {
  hasInput: boolean;
  input?: unknown;
  toolName?: string;
}

export function createLCodeToolProjectionMemory(): LCodeToolProjectionMemory {
  return {
    completeToolInputById: new Map<string, unknown>(),
    streamingToolInputById: new Map<string, LCodeStreamingToolInputState>(),
    toolNameById: new Map<string, string>(),
  };
}

export function ensureLCodeToolProjectionMemory(
  memory: LCodeToolProjectionMemory,
): LCodeToolProjectionMemory {
  memory.completeToolInputById ??= new Map<string, unknown>();
  memory.streamingToolInputById ??= new Map<string, LCodeStreamingToolInputState>();
  memory.toolNameById ??= new Map<string, string>();
  return memory;
}

export function resolveLCodeToolProjectionMetadata(
  payload: Record<string, unknown>,
  toolId: string,
  memory: LCodeToolProjectionMemory,
): LCodeToolProjectionMetadata {
  const toolName = readNonEmptyString(payload.toolName) ?? memory.toolNameById?.get(toolId);
  if (toolName) {
    memory.toolNameById?.set(toolId, toolName);
  }

  if ("input" in payload) {
    return {
      hasInput: payload.input !== undefined,
      input: payload.input,
      toolName,
    };
  }

  if (memory.completeToolInputById?.has(toolId)) {
    return {
      hasInput: true,
      input: memory.completeToolInputById.get(toolId),
      toolName,
    };
  }

  return {
    hasInput: false,
    toolName,
  };
}

export function finalizeLCodeToolProjectionInput(
  toolId: string,
  input: unknown,
  memory: LCodeToolProjectionMemory,
): void {
  memory.completeToolInputById ??= new Map<string, unknown>();
  memory.completeToolInputById.set(toolId, input);
  const streamingState = memory.streamingToolInputById?.get(toolId);
  if (streamingState) {
    streamingState.lastPreviewRawInputLength = streamingState.rawInput.length;
    streamingState.rawInput = "";
  }
}

export function forgetLCodeToolProjectionMetadata(
  toolId: string,
  memory: LCodeToolProjectionMemory,
): void {
  memory.completeToolInputById?.delete(toolId);
  memory.streamingToolInputById?.delete(toolId);
  memory.toolNameById?.delete(toolId);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
