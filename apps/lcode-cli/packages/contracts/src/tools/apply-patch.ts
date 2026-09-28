// ============================================================
// ApplyPatch Tool - Structured patch editing tool
// ============================================================

import { z } from "zod";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import { EditDiffHunkSchema, type DiffHunk } from "./edit.js";
import { toToolJsonSchema } from "./json-schema.js";

export const ApplyPatchInputSchema = z
  .object({
    patch_text: z.string().describe("The full structured patch text to apply"),
  })
  .strict();

export type ApplyPatchInput = z.infer<typeof ApplyPatchInputSchema>;

export const ApplyPatchInputJsonSchema = toToolJsonSchema(ApplyPatchInputSchema);

export const ApplyPatchFileChangeSchema = z
  .object({
    filePath: z.string(),
    type: z.enum(["add", "update", "delete", "move"]),
    movePath: z.string().optional(),
    structuredPatch: z.array(EditDiffHunkSchema),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  })
  .strict();

export interface ApplyPatchFileChange {
  filePath: string;
  type: "add" | "update" | "delete" | "move";
  movePath?: string;
  structuredPatch: DiffHunk[];
  additions: number;
  deletions: number;
}

export interface ApplyPatchOutput {
  files: ApplyPatchFileChange[];
  structuredPatch: DiffHunk[];
  summary: string;
}

export const ApplyPatchOutputSchema = z
  .object({
    files: z.array(ApplyPatchFileChangeSchema),
    structuredPatch: z.array(EditDiffHunkSchema),
    summary: z.string(),
  })
  .strict();

export const ApplyPatchOutputJsonSchema = toToolJsonSchema(ApplyPatchOutputSchema);

export interface ApplyPatchToolCall {
  id: ToolCallId;
  name: "ApplyPatch";
  input: ApplyPatchInput;
  traceId: TraceId;
  startedAt: Date;
}

export interface ApplyPatchToolResult {
  toolCallId: ToolCallId;
  output: ApplyPatchOutput;
  traceId: TraceId;
  durationMs: number;
}

export const ApplyPatchErrorCode = {
  INVALID_PATCH: "apply_patch_invalid_patch",
  EMPTY_PATCH: "apply_patch_empty_patch",
  FILE_NOT_EXIST: "apply_patch_file_not_exist",
  FILE_EXISTS: "apply_patch_file_exists",
  HUNK_NOT_FOUND: "apply_patch_hunk_not_found",
  IO_ERROR: "apply_patch_io_error",
} as const;

export type ApplyPatchErrorCode = (typeof ApplyPatchErrorCode)[keyof typeof ApplyPatchErrorCode];
