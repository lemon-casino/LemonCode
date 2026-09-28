import type { InstanceRef } from "./types.js";
import { INSTRUCTIONS_HEAD_MAX_CHARS, refToString, WorkflowError } from "./types.js";

/** replay 命中但 inputHash 不一致——纯度契约被破坏，run 大声失败。 */
export function hashMismatch(instance: InstanceRef, expected: string, got: string): WorkflowError {
  return new WorkflowError(
    "InputHashMismatch",
    `Replay hit at ${refToString(instance)} but inputHash differs (expected ${expected}, got ` +
      `${got}): the script is not deterministic, so the journal cannot be replayed.`,
    { mismatch: { expected, got } },
  );
}

/** cause -> 一行有界文本；空则给占位。 */
export function describeCause(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  const trimmed = text.trim();
  if (trimmed.length === 0) return "unknown error";
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

/** 作者指令的开头（不加省略号）；空指令不显示预览。 */
export function headOfInstructions(instructions: string): string | undefined {
  const trimmed = instructions.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= INSTRUCTIONS_HEAD_MAX_CHARS
    ? trimmed
    : trimmed.slice(0, INSTRUCTIONS_HEAD_MAX_CHARS);
}
