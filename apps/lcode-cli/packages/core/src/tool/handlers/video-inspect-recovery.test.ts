import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  createRootTraceContext,
  type MessageWithParts,
  type SessionId,
  type MessageId,
  type TurnId,
  type ToolArtifactStorePort,
  type SessionStorePort,
} from "@lcode/contracts";
import { MessageHistoryImpl } from "../../agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../../agent/session-history-hydrator.js";
import { persistToolResultMediaAttachments } from "../../runtime/helpers/tool-result-media-persistence.js";
import { PermissionService } from "../../permission/service.js";
import { ToolRegistryImpl } from "../registry.js";
import { createToolExecutor } from "../executor/impl.js";
import type { ToolExecutorOptions } from "../executor/types.js";
import { videoInspectToolEntry } from "./video-inspect.js";

test("VideoInspect executor output persists image artifacts and cold hydration restores bounded media", async () => {
  const registry = new ToolRegistryImpl();
  registry.register(videoInspectToolEntry);
  const contentByUri = new Map<string, string>();
  const artifactStore = {
    writeToolResultArtifact: async (request) => {
      const uri = `lcode-artifact://image/${contentByUri.size}`;
      contentByUri.set(uri, request.content);
      return {
        id: uri,
        uri,
        bytes: request.content.length,
        contentType: "text/plain",
        createdAt: new Date(),
      };
    },
    readToolResultArtifact: async ({ uri }) => ({
      uri,
      content: contentByUri.get(uri)!,
      bytes: contentByUri.get(uri)!.length,
      contentType: "text/plain",
    }),
  } as ToolArtifactStorePort;
  const options = {
    registry,
    permissionService: new PermissionService(),
    getMode: () => "yolo",
    getWorkingDirectory: () => resolve("video-scope"),
    getWorkspaceRoot: () => resolve("video-scope"),
    sessionId: "sess_video",
    emitEvent: async () => {},
    videoProcessorPort: {
      process: async () => ({
        sourceSha256: "a".repeat(64),
        processorVersion: "test",
        metadata: {
          duration: 2,
          width: 8,
          height: 8,
          sizeBytes: 2,
          hasAudio: false,
          hasSubtitles: false,
        },
        sampleTimes: [0.5],
        frames: [{ timestamp: 0.5, mediaType: "image/jpeg", data: new Uint8Array([1, 2, 3]) }],
        truncated: false,
      }),
    },
    imageProcessorPort: {
      prepareForModel: async (request) => ({
        data: request.data,
        mediaType: "image/jpeg",
        resized: false,
        compressed: false,
        originalSizeBytes: 3,
        transformedSizeBytes: 3,
        strategy: "original",
      }),
    },
  } as ToolExecutorOptions;
  const result = await createToolExecutor(options).execute({
    id: "video-call",
    name: "VideoInspect",
    input: { file_path: resolve("video-scope/input.mp4"), action: "frames", timestamps: [0.5] },
  } as never);
  assert.equal(result.success, true);
  assert.ok(Array.isArray(result.modelContent));
  const trace = createRootTraceContext();
  const persisted = (await persistToolResultMediaAttachments({
    artifactStore,
    sessionStore: {} as SessionStorePort,
    sessionId: "sess_video" as SessionId,
    assistantMessageId: "msg_video" as MessageId,
    turnId: "turn_video" as TurnId,
    toolCallId: "video-call",
    toolName: "VideoInspect",
    traceContext: trace,
    content: result.modelContent!,
  }))!;
  assert.equal(persisted.attachments.length, 1);
  assert.equal(contentByUri.size, 1);
  const history = new MessageHistoryImpl();
  history.init();
  await hydrateMessageHistoryFromSession({
    artifactStore,
    history,
    messages: [
      {
        info: {
          id: "msg_video",
          role: "assistant",
          sessionID: "sess_video",
          time: { created: 1, completed: 2 },
        },
        parts: [
          {
            type: "tool",
            id: "part_video",
            callID: "video-call",
            tool: "VideoInspect",
            state: {
              status: "completed",
              input: {},
              output: "Video frame 0.5s",
              title: "VideoInspect",
              time: { start: 1, end: 2 },
              attachments: persisted.attachments,
              metadata: { modelContentLayout: persisted.modelContentLayout },
            },
          },
        ],
      },
    ] as unknown as MessageWithParts[],
  });
  const tool = history
    .borrowReadOnlyRuntimeEntries()
    .find((entry) => entry.kind !== "attachment" && entry.message.role === "tool");
  assert.ok(tool && tool.kind !== "attachment" && Array.isArray(tool.message.content));
  const restoredImage = tool.message.content.find((block) => block.type === "image");
  assert.equal(
    restoredImage?.type === "image" ? restoredImage.dataUrl : undefined,
    "data:image/jpeg;base64,AQID",
  );
});
