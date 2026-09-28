// ============================================================
// Grep Tool - Content Search Tool
// ============================================================
// Reference: grep-style search tool

import { z } from "zod";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";

export const GrepOutputMode = {
  Content: "content",
  FilesWithMatches: "files_with_matches",
  Count: "count",
} as const;

export type GrepOutputMode = (typeof GrepOutputMode)[keyof typeof GrepOutputMode];

// -----------------------------------------------
// Input Schema
// -----------------------------------------------

export const GrepInputSchema = z.object({
  /**
   * Ripgrep-compatible regular expression pattern to search for in file contents.
   */
  pattern: z
    .string()
    .describe("The regular expression pattern to search for in file contents"),
  /**
   * Optional file or directory to search. Defaults to the current working directory.
   */
  path: z
    .string()
    .optional()
    .describe(
      "File or directory to search in (rg PATH). Defaults to current working directory.",
    ),
  /**
   * Glob pattern to filter files.
   */
  glob: z
    .string()
    .optional()
    .describe('Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob'),
  output_mode: z
    .enum(["content", "files_with_matches", "count"])
    .optional()
    .describe(
      'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "files_with_matches".',
    ),
  "-B": z
    .number()
    .optional()
    .describe(
      'Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.',
    ),
  "-A": z
    .number()
    .optional()
    .describe(
      'Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.',
    ),
  "-C": z
    .number()
    .optional()
    .describe("Alias for context."),
  context: z
    .number()
    .optional()
    .describe(
      'Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.',
    ),
  "-n": z
    .boolean()
    .optional()
    .describe(
      'Show line numbers in output (rg -n). Requires output_mode: "content", ignored otherwise. Defaults to true.',
    ),
  "-i": z.boolean().optional().describe("Case insensitive search (rg -i)"),
  "-o": z
    .boolean()
    .optional()
    .describe(
      'Print only the matched (non-empty) parts of each matching line, one match per output line (rg -o / --only-matching). Requires output_mode: "content", ignored otherwise. Defaults to false.',
    ),
  type: z
    .string()
    .optional()
    .describe(
      "File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.",
    ),
  head_limit: z
    .number()
    .optional()
    .describe(
      'Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults to 250 when unspecified. Pass 0 for unlimited (use sparingly — large result sets waste context).',
    ),
  offset: z
    .number()
    .optional()
    .describe(
      'Skip first N lines/entries before applying head_limit, equivalent to "| tail -n +N | head -N". Works across all output modes. Defaults to 0.',
    ),
  multiline: z
    .boolean()
    .optional()
    .describe(
      "Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.",
    ),
});

export type GrepInput = z.infer<typeof GrepInputSchema>;

export const GrepInputJsonSchema = toToolJsonSchema(GrepInputSchema);

// -----------------------------------------------
// Output Types
// -----------------------------------------------

export interface GrepOutput {
  mode: GrepOutputMode;
  durationMs: number;
  numFiles: number;
  filenames: string[];
  content?: string;
  numLines?: number;
  numMatches?: number;
  truncated: boolean;
  appliedLimit?: number;
  appliedOffset?: number;
}

export const GrepOutputSchema = z
  .object({
    mode: z.enum(["content", "files_with_matches", "count"]),
    durationMs: z.number().int().nonnegative(),
    numFiles: z.number().int().nonnegative(),
    filenames: z.array(z.string()),
    content: z.string().optional(),
    numLines: z.number().int().nonnegative().optional(),
    numMatches: z.number().int().nonnegative().optional(),
    truncated: z.boolean(),
    appliedLimit: z.number().int().nonnegative().optional(),
    appliedOffset: z.number().int().nonnegative().optional(),
  })
  .strict();

export const GrepOutputJsonSchema = toToolJsonSchema(GrepOutputSchema);

// -----------------------------------------------
// Tool Call Structure
// -----------------------------------------------

export interface GrepToolCall {
  id: ToolCallId;
  name: "Grep";
  input: GrepInput;
  traceId: TraceId;
  startedAt: Date;
}

export interface GrepToolResult {
  toolCallId: ToolCallId;
  output: GrepOutput;
  traceId: TraceId;
  durationMs: number;
}

// -----------------------------------------------
// Grep Errors
// -----------------------------------------------

export const GrepErrorCode = {
  INVALID_PATTERN: "grep_invalid_pattern",
  INVALID_PATH: "grep_invalid_path",
  PERMISSION_DENIED: "grep_permission_denied",
  TOO_LARGE: "grep_too_large",
  CANCELLED: "grep_cancelled",
  IO_ERROR: "grep_io_error",
} as const;

export type GrepErrorCode = (typeof GrepErrorCode)[keyof typeof GrepErrorCode];
