import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  createFileSystemError,
  createRootTraceContext,
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES,
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_MESSAGE_ROWS,
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_PART_ROWS,
  type ReadSessionTranscriptWindowInput,
  type SessionTranscriptWindow,
  type FileSystemPort,
  type MessageId,
  type MessageWithParts,
  type Model,
  type ModelRequest,
  type ProjectMemoryPort,
  type ProjectMemoryReview,
  type SessionInfo,
  type SessionStorePort,
} from "@lcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { resolveEnabledProjectMemoryRoot } from "./project-memory.js";
import { scheduleProjectMemoryExtraction } from "./project-memory-extraction.js";

export const WORKSPACE = resolve("automatic-review-workspace-fixture");
export const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export function harness() {
  const requests: ModelRequest[] = [];
  const applied: Array<Parameters<ProjectMemoryPort["applyReview"]>[0]> = [];
  const saved: ProjectMemoryReview[] = [];
  const outcomes: string[] = [];
  const errors: unknown[] = [];
  const optionsSeen: AbortSignal[] = [];
  let readMessages = 0;
  let sessionReads = 0;
  let snapshotReads = 0;
  const windowInputs: ReadSessionTranscriptWindowInput[] = [];
  let windowPatch: Partial<SessionTranscriptWindow> = {};
  let failApply = false;
  let accept = true;
  let noChange = false;
  let modelFailure = false;
  let onModel: ((request: ModelRequest) => void) | undefined;
  const config = {
    memory: { enabled: true, cliStorageRoot: resolve("automatic-review-storage-fixture") },
  };
  const root = resolveEnabledProjectMemoryRoot(config, WORKSPACE)!;
  const session = {
    id: "sess_auto_review",
    projectID: "project_fixture",
    taskType: "interactive",
    directory: WORKSPACE,
    slug: "fixture",
    title: "Fixture",
    version: "1",
    time: { created: 1, updated: 1 },
  } as SessionInfo;
  const boundary = "msg_auto_boundary" as MessageId;
  const durable = [
    {
      info: {
        id: boundary,
        sessionID: session.id,
        role: "user",
        time: { created: 1 },
        agent: "build",
      },
      parts: [
        {
          id: "part_auto_boundary",
          messageID: boundary,
          sessionID: session.id,
          type: "text",
          text: "The project uses deterministic fixture tests.",
        },
      ],
    },
  ] as MessageWithParts[];
  const scope = {
    run: async <T>(fn: () => Promise<T>) => fn(),
    finishCompleted: () => {
      outcomes.push("completed");
    },
    finishCancelled: () => {
      outcomes.push("cancelled");
    },
    finishFailed: (_stage: string, _kind: string, error: unknown) => {
      outcomes.push("failed");
      errors.push(error);
    },
  };
  const model = {
    providerId: "fixture",
    modelId: "captured",
    options: {},
    properties: {
      contextWindow: 200_000,
      inputFormat: { supportsImage: false, supportsPdf: false, supportsVideo: false },
    },
    optionSpecs: { reasoningLevel: { values: ["low"] }, maxOutputTokens: { max: 8192 } },
    generateText: async (request: ModelRequest) => {
      requests.push(request);
      assert.deepEqual(request.tools, [], "automatic review never exposes executable tools");
      onModel?.(request);
      if (modelFailure) throw new Error("fixture model failure");
      const evidence = JSON.parse(
        String(request.messages.find((message) => message.role === "user")!.content),
      );
      if (Array.isArray(evidence.items)) {
        return {
          text: JSON.stringify({
            decisions: evidence.items.map((item: { itemId: string }) => ({
              itemId: item.itemId,
              accept,
              reason: accept ? "Supported project fact." : "Not supported.",
            })),
          }),
          finishReason: "stop",
          usage: {},
        };
      }
      return {
        text: JSON.stringify({
          summary: "Fixture facts",
          items: noChange
            ? []
            : [
                {
                  fileName: "testing.md",
                  content: "The project uses deterministic fixture tests.",
                  reason: "Supported reusable project fact.",
                  sourceIds: [evidence.sources[0].id],
                },
              ],
        }),
        finishReason: "stop",
        usage: {},
      };
    },
  } as unknown as Model;
  const projectMemory: ProjectMemoryPort = {
    registerRoot: async () => {},
    inspectCapacity: async () => ({ available: true }),
    listChanges: async () => {
      throw new Error("Unexpected history read");
    },
    previewUndo: async () => {
      throw new Error("Unexpected undo preview");
    },
    undoChange: async () => {
      throw new Error("Unexpected undo");
    },
    readReview: async () => {
      throw new Error("Unexpected review read");
    },
    listReviews: async () => {
      throw new Error("Unexpected review list");
    },
    saveReview: async (input, options) => {
      assert.equal(input.rootDir, root);
      assert.ok(options?.signal);
      optionsSeen.push(options.signal);
      const proposal: ProjectMemoryReview = {
        schemaVersion: 1,
        id: "proposal_fixture",
        createdAt: 1,
        revision: 1,
        draft: input.draft,
        verification: input.verification,
        appliedItems: {},
      };
      saved.push(proposal);
      return proposal;
    },
    applyReview: async (input, options) => {
      assert.equal(input.rootDir, root);
      assert.ok(options?.signal);
      optionsSeen.push(options.signal);
      applied.push(input);
      if (failApply)
        throw createFileSystemError({ code: "stale_write", message: "fixture conflict" });
      const proposal = saved.find((value) => value.id === input.proposalId)!;
      const item = proposal.draft.items.find((value) => value.id === input.itemId)!;
      return {
        schemaVersion: 1,
        id: "change_fixture",
        fileName: item.fileName,
        createdAt: 1,
        beforeHash: item.expectedHash,
        afterHash: hash(item.content),
        status: "committed",
      };
    },
  } as ProjectMemoryPort;
  const fileSystem = {
    projectMemory,
    listDirectory: async ({ path }: { path: string }) => ({
      path,
      entries: [],
      numEntries: 0,
      durationMs: 0,
      truncated: false,
    }),
    stat: async ({ path }: { path: string }) => {
      if (path === root) return { path, kind: "directory", sizeBytes: 0 };
      throw createFileSystemError({ code: "not_found", message: "fixture missing" });
    },
    writeTextFile: async () => {
      throw new Error("must use governed automatic apply, never legacy Write");
    },
  } as unknown as FileSystemPort;
  const store = {
    messages: async () => {
      readMessages += 1;
      throw new Error("automatic review must not read full history");
    },
    getSession: async () => {
      sessionReads += 1;
      return structuredClone(session);
    },
    listSessions: async () => {
      throw new Error("incremental mode must not scan other sessions");
    },
    readTranscriptSnapshot: async () => {
      snapshotReads += 1;
      throw new Error("automatic review must not fall back to prefix snapshots");
    },
    readTranscriptWindow: async (
      input: ReadSessionTranscriptWindowInput,
    ): Promise<SessionTranscriptWindow> => {
      windowInputs.push(input);
      assert.equal(input.sessionID, session.id);
      assert.deepEqual(input.limits, {
        maxMessageRows: SESSION_TRANSCRIPT_SNAPSHOT_MAX_MESSAGE_ROWS,
        maxPartRows: SESSION_TRANSCRIPT_SNAPSHOT_MAX_PART_ROWS,
        maxDataBytes: SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES,
      });
      const boundaryIndex = durable.findIndex(
        (message) => message.info.id === input.throughMessageID,
      );
      const through = boundaryIndex < 0 ? [] : durable.slice(0, boundaryIndex + 1);
      const messages = structuredClone(through.slice(-input.limits.maxMessageRows));
      return {
        session: structuredClone(session),
        messages,
        loadedMessageCount: messages.length,
        loadedPartCount: messages.reduce((sum, message) => sum + message.parts.length, 0),
        loadedDataBytes: Buffer.byteLength(JSON.stringify(messages)),
        truncated: false,
        throughMessageID: input.throughMessageID,
        boundaryFound: boundaryIndex >= 0,
        prefixTruncated: messages.length < through.length,
        ...windowPatch,
      };
    },
  } as unknown as SessionStorePort;
  const runtime = {
    config,
    sessionId: session.id,
    workspaceRoot: WORKSPACE,
    workingDirectory: WORKSPACE,
    fileSystemPort: fileSystem,
    sessionStore: store,
    latestConversationMessageId: boundary,
    readFileState: new Map(),
    messageHistory: { borrowReadOnlyRuntimeEntries: () => [] },
    getTools: () => [],
    isRemoteWorkspace: () => false,
    agentTelemetry: { captureCausation: () => undefined, detached: () => scope },
  } as unknown as AgentRuntimeInternal;
  return {
    runtime,
    root,
    session,
    boundary,
    durable,
    requests,
    applied,
    saved,
    outcomes,
    errors,
    optionsSeen,
    fileSystem,
    store,
    readMessages: () => readMessages,
    sessionReads: () => sessionReads,
    snapshotReads: () => snapshotReads,
    windowInputs,
    patchWindow: (patch: Partial<SessionTranscriptWindow>) => {
      windowPatch = patch;
    },
    setConflict: (value: boolean) => {
      failApply = value;
    },
    reject: () => {
      accept = false;
    },
    empty: () => {
      noChange = true;
    },
    failModel: () => {
      modelFailure = true;
    },
    onModel: (callback: (request: ModelRequest) => void) => {
      onModel = callback;
    },
    schedule: () =>
      scheduleProjectMemoryExtraction(runtime, {
        model,
        traceContext: createRootTraceContext({ sessionId: session.id }),
      }),
    drain: async () => runtime.memoryExtractionScheduler?.drain(),
  };
}
