// ============================================================
// Glob Tool - File Pattern Matching Tool
// ============================================================
// Reference: glob-style file matching tool

import { z } from "zod";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";

// -----------------------------------------------
// Input Schema
// -----------------------------------------------

export const GlobInputSchema = z.object({
  /**
   * The glob pattern to match files against.
   */
  pattern: z.string().describe("The glob pattern to match files against"),
  /**
   * Optional directory to search. Defaults to the current working directory.
   */
  path: z
    .string()
    .optional()
    .describe(
      'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.',
    ),
});

export type GlobInput = z.infer<typeof GlobInputSchema>;

export const GlobInputJsonSchema = toToolJsonSchema(GlobInputSchema);

// -----------------------------------------------
// Output Types
// -----------------------------------------------

export interface GlobOutput {
  durationMs: number;
  numFiles: number;
  filenames: string[];
  truncated: boolean;
}

export const GlobOutputSchema = z
  .object({
    durationMs: z.number().int().nonnegative(),
    numFiles: z.number().int().nonnegative(),
    filenames: z.array(z.string()),
    truncated: z.boolean(),
  })
  .strict();

export const GlobOutputJsonSchema = toToolJsonSchema(GlobOutputSchema);

// -----------------------------------------------
// Tool Call Structure
// -----------------------------------------------

export interface GlobToolCall {
  id: ToolCallId;
  name: "Glob";
  input: GlobInput;
  traceId: TraceId;
  startedAt: Date;
}

export interface GlobToolResult {
  toolCallId: ToolCallId;
  output: GlobOutput;
  traceId: TraceId;
  durationMs: number;
}

// -----------------------------------------------
// Glob Errors
// -----------------------------------------------

export const GlobErrorCode = {
  INVALID_PATTERN: "glob_invalid_pattern",
  INVALID_PATH: "glob_invalid_path",
  PERMISSION_DENIED: "glob_permission_denied",
  IO_ERROR: "glob_io_error",
} as const;

export type GlobErrorCode = (typeof GlobErrorCode)[keyof typeof GlobErrorCode];
