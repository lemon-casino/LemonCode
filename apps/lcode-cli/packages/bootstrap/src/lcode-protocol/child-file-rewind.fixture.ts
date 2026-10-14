import {
  SESSION_ENTRY_WORKSPACE_CHECKPOINT,
  RewindScope,
  type FileSystemPort,
  type SessionEntryInfo,
  type ToolArtifactStorePort,
} from "@lcode/contracts";
import { childHistoryFixture } from "./child-history-readonly.fixture.js";

export function childFileRewindFixture() {
  const f = childHistoryFixture();
  let content = "after";
  const writes: string[] = [];
  const entries = [
    {
      id: "checkpoint-entry",
      sessionID: f.sessionId,
      type: SESSION_ENTRY_WORKSPACE_CHECKPOINT,
      time: { created: 2, updated: 2 },
      data: {
        eventId: "checkpoint-event",
        sequenceNumber: 1,
        traceId: "fixture-trace",
        turnId: "turn",
        payload: {
          checkpointId: "checkpoint",
          messageId: "user",
          scope: RewindScope.Workspace,
          snapshotRef: "lcode-artifact://fixture/checkpoint",
          fileCount: 1,
        },
      },
    },
  ] as unknown as SessionEntryInfo[];
  f.store.sessionEntries = async (input) =>
    entries.filter((entry) => !input.type || entry.type === input.type);
  f.store.saveSessionEntry = async (entry) => {
    entries.push(entry);
  };
  f.context.deps.conversationReadPorts = {
    artifactStore: {
      readToolResultArtifact: async () => ({
        content: JSON.stringify({
          version: 1,
          kind: "workspace_file_before_change",
          createdAt: "2026-01-01T00:00:00.000Z",
          toolCallId: "tool",
          toolName: "Write",
          files: [
            {
              path: "one.txt",
              beforeContent: "before",
              afterContent: "after",
              existedBefore: true,
              structuredPatch: [],
            },
          ],
        }),
      }),
    } as unknown as ToolArtifactStorePort,
    fileSystemPort: {
      readTextFile: async () => ({ content }),
      writeTextFile: async (input: { content: string }) => {
        content = input.content;
        writes.push(content);
        return {};
      },
      removeFile: async () => ({}),
    } as unknown as FileSystemPort,
  };
  return { ...f, entries, writes, content: () => content };
}
