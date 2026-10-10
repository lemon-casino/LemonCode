import { z } from "zod";
import type { MessageWithParts } from "./transcript.js";
import type { SessionInfo } from "./session-records.js";

export const CONTEXT_CAPSULE_ENTRY_TYPE = "runtime/context_capsule";
export const CONTEXT_CAPSULE_MAX_PER_SESSION = 64;
export const CONTEXT_CAPSULE_SOURCE_MAX_BYTES = 2 * 1024 * 1024;
export const ContextCapsuleScopeSchema = z
  .object({
    workspaceIdentity: z.string().optional(),
    directory: z.string(),
    path: z.string().optional(),
  })
  .strict();
export const ContextCapsuleSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^capsule_[a-f0-9]{32}$/),
    sourceSessionId: z.string().min(1),
    sourceScope: ContextCapsuleScopeSchema,
    sourceBoundaryMessageId: z.string().min(1),
    sourceMessageIds: z.array(z.string().min(1)).min(1).max(5000),
    sourceVersion: z.string().regex(/^[a-f0-9]{64}$/),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    content: z
      .string()
      .min(1)
      .max(48000)
      .refine(
        (content) => new TextEncoder().encode(content).byteLength <= 48 * 1024,
        "Capsule content exceeds 48 KiB.",
      ),
    strategy: z.literal("handoff"),
    generatorVersion: z.literal("handoff-v1"),
    truncated: z.boolean(),
    createdAtMs: z.number().int().nonnegative(),
    targetSessionId: z.string().min(1),
    targetScope: ContextCapsuleScopeSchema,
    targetMessageId: z.string().min(1),
    targetTurnId: z.string().min(1),
    operationId: z.string().min(1),
    references: z
      .array(
        z
          .object({
            messageId: z.string(),
            partId: z.string().optional(),
            index: z.number().int().nonnegative().optional(),
            role: z.enum(["user", "assistant"]).optional(),
            reason: z.string().optional(),
          })
          .strict(),
      )
      .max(5000),
  })
  .strict()
  .refine(
    (capsule) =>
      capsule.sourceMessageIds.at(-1) === capsule.sourceBoundaryMessageId &&
      new Set(capsule.sourceMessageIds).size === capsule.sourceMessageIds.length,
    "Invalid source boundary.",
  );
export type ContextCapsule = z.infer<typeof ContextCapsuleSchema>;
export type ContextCapsuleCommitResult =
  | { status: "committed" | "reused"; capsule: ContextCapsule }
  | { status: "stale" | "unavailable" };
export interface ContextCapsuleAttachInput {
  sessionId: string;
  inputId: string;
  targetMessageId: string;
  targetTurnId: string;
  capsuleIds: string[];
  expectedScope: z.infer<typeof ContextCapsuleScopeSchema>;
}

/** Pure source selector; a committed logical-turn anchor wins, legacy records fail closed on unfinished tools. */
export function stableContextMessages(messages: readonly MessageWithParts[]): MessageWithParts[] {
  const unfinishedIndex = messages.findIndex(
    (message) =>
      (message.info.role === "assistant" && message.info.time.completed === undefined) ||
      message.parts.some(
        (part) =>
          part.type === "tool" &&
          (part.state.status === "pending" || part.state.status === "running"),
      ),
  );
  const committed = unfinishedIndex < 0 ? messages : messages.slice(0, unfinishedIndex);
  const boundary = committed.findLastIndex((message) => {
    if (
      message.info.role !== "assistant" ||
      message.info.error ||
      message.info.time.completed === undefined
    )
      return false;
    if (
      message.parts.some(
        (part) =>
          part.type === "tool" &&
          (part.state.status === "pending" || part.state.status === "running"),
      )
    )
      return false;
    if (message.info.anchor?.boundaryMessageId === message.info.id) return true;
    return message.info.finish !== "tool-calls" && message.info.finish !== "tool_use";
  });
  return boundary < 0 ? [] : committed.slice(0, boundary + 1);
}

/** Both core and storage hash exactly this bounded source representation; no IO or platform hashing here. */
export function contextCapsuleSourcePayload(
  session: Pick<SessionInfo, "id" | "workspaceID" | "directory" | "path" | "revert">,
  messages: readonly MessageWithParts[],
): string {
  if (messages.length > 5000) throw new RangeError("Handoff source exceeds 5000 messages.");
  const payload = {
    sessionId: session.id,
    workspaceIdentity: session.workspaceID?.trim() || undefined,
    directory: session.directory,
    path: session.path,
    revert: session.revert,
    messages: messages.map((message) => ({
      id: message.info.id,
      role: message.info.role,
      ...(message.info.role === "assistant"
        ? {
            completed: message.info.time.completed,
            error: message.info.error,
            finish: message.info.finish,
          }
        : {}),
      parts: message.parts,
    })),
  };
  if (!boundedSourceValue(payload))
    throw new RangeError("Handoff source exceeds its 2 MiB structured content budget.");
  return JSON.stringify(payload);
}

/** Count a conservative JSON UTF-8 bound before constructing its serialized string. */
function boundedSourceValue(root: unknown): boolean {
  let bytes = 0,
    nodes = 0;
  const ancestors = new Set<object>();
  const textFits = (text: string) => {
    bytes += 2;
    for (const character of text) {
      const point = character.codePointAt(0)!;
      bytes +=
        point < 32
          ? 6
          : point === 34 || point === 92
            ? 2
            : point < 128
              ? 1
              : point < 2048
                ? 2
                : point < 65536
                  ? 3
                  : 4;
      if (bytes > CONTEXT_CAPSULE_SOURCE_MAX_BYTES) return false;
    }
    return true;
  };
  const walk = (value: unknown, depth: number): boolean => {
    if (++nodes > 100000 || depth > 20 || bytes > CONTEXT_CAPSULE_SOURCE_MAX_BYTES) return false;
    if (typeof value === "string") return textFits(value);
    if (value === null || typeof value !== "object") {
      bytes += 32;
      return bytes <= CONTEXT_CAPSULE_SOURCE_MAX_BYTES;
    }
    if (ancestors.has(value)) return false;
    ancestors.add(value);
    bytes += 2;
    let valid = true;
    if (Array.isArray(value)) {
      for (const child of value) {
        bytes++;
        if (!walk(child, depth + 1)) {
          valid = false;
          break;
        }
      }
    } else {
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        bytes += 2;
        if (!textFits(key) || !walk((value as Record<string, unknown>)[key], depth + 1)) {
          valid = false;
          break;
        }
      }
    }
    ancestors.delete(value);
    return valid && bytes <= CONTEXT_CAPSULE_SOURCE_MAX_BYTES;
  };
  return walk(root, 0);
}
