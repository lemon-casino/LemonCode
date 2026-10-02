import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  ProjectMemoryReviewItemSchema,
  type ProjectMemoryReviewSource,
  type TraceContext,
} from "@lcode/contracts";
import type { ToolExecutionContext } from "../tool/types.js";
import { resolveSafeMemoryFilePath } from "./memory-file-path.js";

export const REVIEW_SESSION_LIMIT = 8;
export const REVIEW_SESSION_CHARACTER_LIMIT = 12_000;
export const REVIEW_SESSION_TOTAL_CHARACTER_LIMIT = 64_000;
export const REVIEW_MEMORY_LIMIT = 8;
export const REVIEW_MEMORY_CHARACTER_LIMIT = 16_000;
export const REVIEW_CATALOG_CHARACTER_LIMIT = 6_000;
export const REVIEW_QUERY_CHARACTER_LIMIT = 4_000;
export const REVIEW_REQUEST_CHARACTER_LIMIT = 96_000;
export const REVIEW_REQUEST_TOKEN_LIMIT = 32_000;
export const REVIEW_REQUEST_TOKEN_RESERVE = 1_024;
export const REVIEW_OUTPUT_TOKEN_LIMIT = 4_096;
export const REVIEW_RESPONSE_CHARACTER_LIMIT = 80_000;
export const REVIEW_PATH_DEPTH_LIMIT = 8;

const SOURCE_REVISION_PATTERN = /^review-v1:([a-f0-9]{64}):(0|[1-9][0-9]{0,4}):([a-f0-9]{64})$/u;
const RESERVED_FILE_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const UNSAFE_SEGMENT_PATTERN = /[. ]$|[<>"|?*\u007f\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/u;
const PROTECTED_SEGMENTS = new Set(["agents.md", "memory.md", "skill.md", "memory-state"]);

export type MemoryReviewErrorCode =
  | "unavailable"
  | "cancelled"
  | "invalid_query"
  | "invalid_response"
  | "budget_exceeded"
  | "source_unavailable"
  | "stale_source"
  | "invalid_target"
  | "model_failed";

const ERROR_MESSAGES: Record<MemoryReviewErrorCode, string> = {
  unavailable: "Memory review requires a scoped main session and bounded read capabilities.",
  cancelled: "Memory review was cancelled.",
  invalid_query: "Memory review query is empty or exceeds its budget.",
  invalid_response: "Memory review model response is not a valid evidence-backed proposal.",
  budget_exceeded: "Memory review exceeded its bounded evidence or model budget.",
  source_unavailable: "Memory review evidence is unavailable or outside the current scope.",
  stale_source: "Memory review evidence changed; create a new review before applying it.",
  invalid_target:
    "Memory review target is unsafe or was not completely read in the frozen evidence.",
  model_failed: "Memory review auxiliary model request failed.",
};

export class MemoryReviewError extends Error {
  constructor(readonly code: MemoryReviewErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = code === "cancelled" ? "AbortError" : "MemoryReviewError";
  }
}

export interface FrozenReviewSource {
  source: ProjectMemoryReviewSource;
  content: string;
  expectedHash?: string;
  partial: boolean;
}

export function throwIfReviewAborted(context: ToolExecutionContext): void {
  // 原始 abort reason 可能包含用户正文或底层地址，公开错误只保留固定语义。
  if (context.abortSignal.aborted) throw new MemoryReviewError("cancelled");
}

/** SessionStore 尚无 signal 入参；等待可取消，且取消后不得继续发出新的 I/O。 */
export function reviewIO<T>(
  context: ToolExecutionContext,
  run: () => Promise<T>,
  failureCode: MemoryReviewErrorCode = "source_unavailable",
): Promise<T> {
  throwIfReviewAborted(context);
  return new Promise<T>((resolveResult, reject) => {
    const signal = context.abortSignal;
    const aborted = () => reject(new MemoryReviewError("cancelled"));
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve()
      .then(() => {
        throwIfReviewAborted(context);
        return run();
      })
      .then(
        (value) => {
          signal.removeEventListener("abort", aborted);
          if (signal.aborted) aborted();
          else resolveResult(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", aborted);
          // 不把 port/provider 原始错误、cause 或正文带入上层日志。
          reject(
            signal.aborted
              ? new MemoryReviewError("cancelled")
              : error instanceof MemoryReviewError
                ? error
                : new MemoryReviewError(failureCode),
          );
        },
      );
  });
}

export function reviewTrace(context: ToolExecutionContext): TraceContext {
  return (
    context.traceContext ??
    ({
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      turnId: context.turnId,
    } as TraceContext)
  );
}

export function assertReviewCapabilities(context: ToolExecutionContext): void {
  throwIfReviewAborted(context);
  if (
    !context.fileSystemPort ||
    !context.memoryRoot ||
    !isAbsolute(context.memoryRoot) ||
    !isAbsolute(context.workspaceRoot) ||
    (context.reviewMode === "incremental"
      ? !context.sessionStore?.readTranscriptWindow
      : !context.sessionStore?.readTranscriptSnapshot) ||
    context.runtimeScope === "subagent" ||
    context.automationTurn ||
    context.offPeakTurn ||
    (context.reviewMode === "incremental" &&
      (!context.reviewBoundary ||
        context.reviewBoundary.sessionId !== context.sessionId ||
        !context.reviewBoundary.messageId)) ||
    (context.remoteSessionId && !context.workspaceIdentity?.trim())
  ) {
    throw new MemoryReviewError("unavailable");
  }
}

export function reviewHash(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex")}`;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function scopeHash(context: ToolExecutionContext): string {
  return reviewHash({
    workspace: context.workspaceIdentity?.trim() || resolve(context.workspaceRoot),
    memoryRoot: resolve(context.memoryRoot!),
  }).slice("sha256:".length);
}

function sourceId(
  context: ToolExecutionContext,
  kind: ProjectMemoryReviewSource["kind"],
  reference: string,
  boundaryMessageId?: string,
  projection?: "latest-turn",
): string {
  const identity = [scopeHash(context), kind, reference];
  if (boundaryMessageId || projection) identity.push(boundaryMessageId ?? "", projection ?? "");
  return `source_${reviewHash(identity).slice("sha256:".length)}`;
}

export function createReviewSource(input: {
  context: ToolExecutionContext;
  kind: ProjectMemoryReviewSource["kind"];
  reference: string;
  characterLimit: number;
  material: unknown;
  boundaryMessageId?: string;
  projection?: "latest-turn";
}): ProjectMemoryReviewSource {
  const scope = scopeHash(input.context);
  const digest = reviewHash([
    scope,
    input.kind,
    input.reference,
    input.characterLimit,
    input.material,
    ...(input.boundaryMessageId || input.projection
      ? [input.boundaryMessageId ?? "", input.projection ?? ""]
      : []),
  ]);
  return {
    id: sourceId(
      input.context,
      input.kind,
      input.reference,
      input.boundaryMessageId,
      input.projection,
    ),
    kind: input.kind,
    reference: input.reference,
    revision: `review-v1:${scope}:${input.characterLimit}:${digest.slice("sha256:".length)}`,
    ...(input.boundaryMessageId ? { boundaryMessageId: input.boundaryMessageId } : {}),
    ...(input.projection ? { projection: input.projection } : {}),
  };
}

export function reviewSourceCharacterLimit(
  source: ProjectMemoryReviewSource,
  context: ToolExecutionContext,
): number {
  const match = SOURCE_REVISION_PATTERN.exec(source.revision);
  const limit = Number(match?.[2]);
  if (
    !match ||
    match[1] !== scopeHash(context) ||
    source.id !==
      sourceId(
        context,
        source.kind,
        source.reference,
        source.boundaryMessageId,
        source.projection,
      ) ||
    (source.projection && (source.kind !== "session" || !source.boundaryMessageId)) ||
    (source.boundaryMessageId && source.kind !== "session") ||
    (source.kind === "session" ? limit < 1 || limit > REVIEW_SESSION_CHARACTER_LIMIT : limit !== 0)
  ) {
    throw new MemoryReviewError("stale_source");
  }
  return limit;
}

export function reviewFileName(root: string, filePath: string): string {
  const name = relative(resolve(root), resolve(filePath)).split(sep).join("/");
  assertSafeReviewFileName(name, root);
  return name;
}

export function assertSafeReviewFileName(fileName: string, root: string): string {
  const parts = fileName.split("/");
  if (
    !ProjectMemoryReviewItemSchema.shape.fileName.safeParse(fileName).success ||
    parts.length > REVIEW_PATH_DEPTH_LIMIT ||
    parts.some(
      (part) =>
        part.startsWith(".") ||
        RESERVED_FILE_PATTERN.test(part) ||
        UNSAFE_SEGMENT_PATTERN.test(part) ||
        PROTECTED_SEGMENTS.has(part.toLowerCase()),
    )
  ) {
    throw new MemoryReviewError("invalid_target");
  }
  const result = resolveSafeMemoryFilePath({
    filePath: fileName,
    rootDir: root,
    workingDirectory: root,
    workspaceRoot: root,
  });
  if (!result) throw new MemoryReviewError("invalid_target");
  return result;
}
