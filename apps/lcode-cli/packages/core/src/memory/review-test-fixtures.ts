import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  createFileSystemError,
  getCurrentModelInvocationContext,
  type FileSystemListDirectoryEntry,
  type FileSystemPort,
  type MessageId,
  type MessageWithParts,
  type Model,
  type ModelInvocationContext,
  type ModelRequest,
  type ModelTextResult,
  type ProjectMemoryReviewDraft,
  type PartId,
  type ReadSessionTranscriptSnapshotInput,
  type ReadSessionTranscriptWindowInput,
  type SessionId,
  type SessionInfo,
  type SessionStorePort,
  type TraceId,
} from "@lcode/contracts";
import type { ToolExecutionContext } from "../tool/types.js";

export const REVIEW_FIXTURE_ROOT = resolve("review-fake-workspace");
export const REVIEW_FIXTURE_MEMORY_ROOT = join(REVIEW_FIXTURE_ROOT, "memory");
export const REVIEW_CURRENT_SESSION = "sess_review_current" as SessionId;
export const REVIEW_PAST_SESSION = "sess_review_past" as SessionId;

export interface ReviewPrompt {
  query: string;
  sources: { id: string; kind: "session" | "memory"; reference: string; content: string }[];
  otherMemoryFileNames: string[];
}

export function readReviewPrompt(request: ModelRequest): ReviewPrompt {
  const content = request.messages.find((message) => message.role === "user")?.content;
  assert.equal(typeof content, "string");
  return JSON.parse(content as string) as ReviewPrompt;
}

export function reviewSession(
  id = REVIEW_PAST_SESSION,
  patch: Partial<SessionInfo> = {},
): SessionInfo {
  return {
    id,
    projectID: "project_review_fixture",
    taskType: "interactive",
    slug: id,
    directory: REVIEW_FIXTURE_ROOT,
    title: "Memory design",
    version: "1",
    time: { created: 1, updated: 1 },
    ...patch,
  } as SessionInfo;
}

export function reviewMessage(
  sessionID = REVIEW_PAST_SESSION,
  text = "Memory updates require explicit approval.",
  id = "msg_review_past",
): MessageWithParts {
  const messageID = id as MessageId;
  return {
    info: { id: messageID, sessionID, role: "user", agent: "build", time: { created: 1 } },
    parts: [{ id: `part_${id}` as PartId, sessionID, messageID, type: "text", text }],
  };
}

export function fixtureHash(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

interface FakeMemoryFile {
  content: string;
  rawContent?: string;
  truncated?: boolean;
  noHash?: boolean;
  kind?: "file" | "symlink";
}

export function reviewHarness() {
  const controller = new AbortController();
  const sessions = new Map<SessionId, SessionInfo>([
    [REVIEW_CURRENT_SESSION, reviewSession(REVIEW_CURRENT_SESSION)],
    [REVIEW_PAST_SESSION, reviewSession()],
  ]);
  const transcripts = new Map<SessionId, MessageWithParts[]>([
    [
      REVIEW_CURRENT_SESSION,
      [reviewMessage(REVIEW_CURRENT_SESSION, "Review memory design.", "msg_review_current")],
    ],
    [REVIEW_PAST_SESSION, [reviewMessage()]],
  ]);
  const files = new Map<string, FakeMemoryFile>();
  const reads: string[] = [];
  const stats: string[] = [];
  const snapshots: ReadSessionTranscriptSnapshotInput[] = [];
  const windows: ReadSessionTranscriptWindowInput[] = [];
  const requests: ModelRequest[] = [];
  const invocations: (ModelInvocationContext | undefined)[] = [];
  const lists: Parameters<SessionStorePort["listSessions"]>[0][] = [];
  const failWrite = async (): Promise<never> => {
    throw new Error("A review must not write");
  };
  const fileSystem = {
    async listDirectory(request, options) {
      assert.equal(options?.signal, controller.signal);
      const directory = resolve(request.path);
      const entries = new Map<string, FileSystemListDirectoryEntry>();
      for (const [filePath, file] of files) {
        const rel = relative(directory, filePath);
        if (!rel || rel.startsWith("..") || resolve(directory, rel) !== filePath) continue;
        const segments = rel.split(sep);
        const name = segments[0]!;
        entries.set(name, {
          name,
          path: join(directory, name),
          kind: segments.length > 1 ? "directory" : (file.kind ?? "file"),
        });
      }
      if (directory !== REVIEW_FIXTURE_MEMORY_ROOT && entries.size === 0 && !files.has(directory)) {
        throw createFileSystemError({ code: "not_found", message: "Missing fake directory" });
      }
      const all = [...entries.values()];
      return {
        path: directory,
        durationMs: 0,
        entries: all.slice(0, request.limit),
        numEntries: all.length,
        truncated: request.limit !== undefined && all.length > request.limit,
      };
    },
    async readTextFile(request, options) {
      assert.equal(options?.signal, controller.signal);
      assert.ok(request.maxBytes !== undefined && request.maxBytes <= 256 * 1024);
      reads.push(request.path);
      const file = files.get(request.path);
      if (!file) throw createFileSystemError({ code: "not_found", message: "Missing fake memory" });
      const bytes = Buffer.byteLength(file.rawContent ?? file.content);
      if (bytes > request.maxBytes!) {
        throw createFileSystemError({
          code: "too_large",
          message: "Fake file exceeds byte budget",
        });
      }
      return {
        path: request.path,
        content: file.content,
        bytesRead: bytes,
        sizeBytes: bytes,
        truncated: file.truncated ?? false,
        encoding: "utf8" as const,
        revision: {
          id: "fake-revision",
          ...(file.noHash ? {} : { hash: fixtureHash(file.rawContent ?? file.content) }),
        },
      };
    },
    async stat(request, options) {
      assert.equal(options?.signal, controller.signal);
      stats.push(request.path);
      const file = files.get(request.path);
      if (file)
        return {
          path: request.path,
          kind: file.kind ?? "file",
          sizeBytes: Buffer.byteLength(file.content),
        };
      if (
        request.path === REVIEW_FIXTURE_MEMORY_ROOT ||
        [...files.keys()].some((path) => dirname(path) === request.path)
      ) {
        return { path: request.path, kind: "directory", sizeBytes: 0 };
      }
      throw createFileSystemError({ code: "not_found", message: "Missing fake target" });
    },
    createDirectory: failWrite,
    writeTextFile: failWrite,
    removeFile: failWrite,
    readTextFileRange: failWrite,
    readBinaryFile: failWrite,
    searchFiles: failWrite,
    searchText: failWrite,
  } satisfies FileSystemPort;
  const store = {
    async getSession(id: SessionId) {
      return structuredClone(sessions.get(id) ?? null);
    },
    async listSessions(input: Parameters<SessionStorePort["listSessions"]>[0]) {
      lists.push(input);
      return structuredClone([...sessions.values()].slice(0, input?.limit));
    },
    async readTranscriptSnapshot(input: ReadSessionTranscriptSnapshotInput) {
      snapshots.push(input);
      const messages = structuredClone(transcripts.get(input.sessionID) ?? []);
      return {
        session: structuredClone(sessions.get(input.sessionID) ?? null),
        messages,
        loadedMessageCount: messages.length,
        loadedPartCount: messages.reduce((count, message) => count + message.parts.length, 0),
        loadedDataBytes: Buffer.byteLength(JSON.stringify(messages)),
        truncated: false,
      };
    },
    async readTranscriptWindow(input: ReadSessionTranscriptWindowInput) {
      windows.push(input);
      const all = transcripts.get(input.sessionID) ?? [];
      const index = all.findIndex((message) => message.info.id === input.throughMessageID);
      const start = Math.max(0, index + 1 - input.limits.maxMessageRows);
      const messages = index < 0 ? [] : structuredClone(all.slice(start, index + 1));
      return {
        session: structuredClone(sessions.get(input.sessionID) ?? null),
        messages,
        loadedMessageCount: messages.length,
        loadedPartCount: messages.reduce((count, message) => count + message.parts.length, 0),
        loadedDataBytes: Buffer.byteLength(JSON.stringify(messages)),
        truncated: false,
        throughMessageID: input.throughMessageID,
        boundaryFound: index >= 0,
        prefixTruncated: start > 0,
      };
    },
    messages: failWrite,
  } as unknown as SessionStorePort;
  const state = {
    reply: (
      _request: ModelRequest,
    ): Partial<ModelTextResult> | Promise<Partial<ModelTextResult>> => ({
      text: JSON.stringify({ summary: "No new durable facts.", items: [] }),
    }),
  };
  const model = {
    properties: { contextWindow: 200_000 },
    optionSpecs: { reasoningLevel: { values: ["low", "high"] }, maxOutputTokens: { max: 8192 } },
    async generateText(request: ModelRequest) {
      requests.push(request);
      invocations.push(getCurrentModelInvocationContext());
      return {
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 10 },
        ...(await state.reply(request)),
      };
    },
  } as unknown as Model;
  const context: ToolExecutionContext = {
    abortSignal: controller.signal,
    sessionId: REVIEW_CURRENT_SESSION,
    toolCallId: "call_review_fixture",
    traceId: "trace_review_fixture" as TraceId,
    workingDirectory: REVIEW_FIXTURE_ROOT,
    workspaceRoot: REVIEW_FIXTURE_ROOT,
    memoryRoot: REVIEW_FIXTURE_MEMORY_ROOT,
    runtimeScope: "main",
    fileSystemPort: fileSystem,
    sessionStore: store,
    model,
    emitEvent: failWrite,
  };
  return {
    context,
    controller,
    files,
    sessions,
    transcripts,
    fileSystem,
    store,
    model,
    reads,
    stats,
    snapshots,
    windows,
    requests,
    invocations,
    lists,
    state,
  };
}

export function reviewDecisionResponse(
  draft: ProjectMemoryReviewDraft,
  accept = true,
): Partial<ModelTextResult> {
  return {
    text: JSON.stringify({
      decisions: draft.items.map((item) => ({
        itemId: item.id,
        accept,
        reason: accept ? "Supported reusable project fact." : "Not supported.",
      })),
    }),
  };
}

export function oneReviewItem(request: ModelRequest, patch: Record<string, unknown> = {}) {
  const source = readReviewPrompt(request).sources[0];
  assert.ok(source);
  return {
    text: JSON.stringify({
      summary: "A durable design constraint.",
      items: [
        {
          fileName: "design.md",
          content: "Memory proposals need approval.",
          reason: "Confirmed design.",
          sourceIds: [source.id],
          ...patch,
        },
      ],
    }),
  };
}
