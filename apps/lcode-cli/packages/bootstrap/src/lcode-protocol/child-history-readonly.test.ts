import assert from "node:assert/strict";
import test from "node:test";
import { createV4HydrationHost } from "./v4-bridge-hydration.js";
import { createConversationV4Gateway } from "./v4-bridge.js";
import { childHistoryFixture } from "./child-history-readonly.fixture.js";
import { createV4ReadHost } from "./v4-bridge-read-host.js";
import { browserFixture } from "./browser-control-broker.fixture.js";
import {
  createInMemorySessionEventStore,
  type FileSystemPort,
  type ToolArtifactStorePort,
} from "@lcode/contracts";
import type { LCodeProtocolSessionRecord } from "./server-types.js";

test("parent-inactive child hydration reads the durable transcript without an executable record", async () => {
  const f = childHistoryFixture();
  const loaded = await createV4HydrationHost(f.context, undefined).loadPersistedEvents!(
    f.sessionId,
  );
  assert.ok(
    loaded.events.some((event) => JSON.stringify(event.payload).includes("saved child reply")),
  );
  assert.equal(f.context.sessions.size, 0);
  assert.equal(f.appCreations(), 0);
});

for (const clientMode of ["desktop-continuous", "web-remote-replayable"] as const) {
  test(`cold child rows query through ${clientMode} never activates a runtime`, async () => {
    const f = childHistoryFixture();
    const gateway = createConversationV4Gateway(f.context);
    try {
      const result = await gateway.rowsRange({ sessionId: f.sessionId, limit: 20, clientMode });
      assert.ok(JSON.stringify(result).includes("saved child reply"));
      assert.equal(f.context.sessions.size, 0);
      assert.equal(f.appCreations(), 0);
    } finally {
      gateway.dispose();
    }
  });
}

test("child capacity comes from its own physical model, never from the active parent model", async () => {
  const f = childHistoryFixture();
  f.context.sessions.set("parent", {
    workspace: { workspacePath: "fixture", workspaceKey: "fixture" },
    eventStore: createInMemorySessionEventStore(),
    app: {
      getModelOption: () => {
        assert.fail("parent capacity must not be read");
      },
    },
  } as unknown as LCodeProtocolSessionRecord);
  f.context.deps.conversationReadPorts = {
    artifactStore: {} as ToolArtifactStorePort,
    fileSystemPort: {} as FileSystemPort,
    modelContextWindow: (selection) => {
      assert.equal(selection.modelId, "child-B");
      return 512;
    },
  };
  const loaded = await createV4HydrationHost(f.context, undefined).loadPersistedEvents!(
    f.sessionId,
  );
  assert.equal(loaded.configSeed?.modelSelection?.modelId, "child-B");
  assert.equal(loaded.usageSeed?.contextWindow.maxTokens, 512);
});

test("parent-inactive attachments validate the child message and prefer the immutable artifact", async () => {
  const f = childHistoryFixture();
  const seen: string[] = [];
  f.messages[0].parts.push({
    type: "file",
    id: "image",
    mime: "image/png",
    url: "changed-image.png",
    metadata: { artifactUri: "lcode-artifact://fixture/image" },
  } as never);
  f.store.messageWithParts = async (input) => {
    assert.equal(input.sessionID, f.sessionId);
    return f.messages[0];
  };
  f.context.deps.conversationReadPorts = {
    artifactStore: {
      readToolResultArtifact: async ({ uri }: { uri: string }) => {
        seen.push(uri);
        return { content: "data:image/png;base64,YWJj" };
      },
    } as unknown as ToolArtifactStorePort,
    fileSystemPort: {
      readBinaryFile: () => {
        assert.fail("changed source path must not be read");
      },
    } as unknown as FileSystemPort,
  };
  const result = await createV4ReadHost(f.context).readSessionAttachment!(f.sessionId, {
    ref: "changed-image.png",
    mime: "image/png",
    maxBytes: 10,
    messageId: "user",
    attachmentIndex: 0,
  });
  assert.equal(Buffer.from(result.bytes).toString(), "abc");
  assert.deepEqual(seen, ["lcode-artifact://fixture/image"]);
  assert.equal(f.appCreations(), 0);
});

test("cold child history cannot revive a retired Browser turn or occupy an actor execution identity", async () => {
  const f = childHistoryFixture();
  const browser = browserFixture();
  f.stored.parentID = "root";
  f.stored.workspaceID = "C:/workspace";
  f.stored.path = "C:/workspace";
  f.stored.directory = "C:/workspace";
  f.context.sessions = browser.sessions;
  browser.sessions.get("root")!.eventStore = createInMemorySessionEventStore();
  const old = browser.port.createChildScope!({ parentSessionId: "root", sessionId: f.sessionId });
  await old.turnEnded!({ sessionId: f.sessionId, turnId: "old" });
  await old.closeSession!({ sessionId: f.sessionId });
  const gateway = createConversationV4Gateway(f.context);
  try {
    await gateway.rowsRange({
      sessionId: f.sessionId,
      limit: 20,
      clientMode: "desktop-continuous",
    });
    assert.equal(f.context.sessions.has(f.sessionId), false);
    const resumed = browser.port.createChildScope!({
      parentSessionId: "root",
      sessionId: f.sessionId,
    });
    await assert.rejects(
      browser.port.list({ sessionId: f.sessionId, turnId: "old" }),
      (error: unknown) => (error as { reason: string }).reason === "turn_inactive",
    );
    await resumed.list({ sessionId: f.sessionId, turnId: "new" });
    await resumed.closeSession!({ sessionId: f.sessionId });
  } finally {
    gateway.dispose();
  }
});

test("persisted history read failures remain explicit instead of producing an empty snapshot", async () => {
  const f = childHistoryFixture();
  f.store.messages = async () => {
    throw new Error("fixture history read failed");
  };
  const gateway = createConversationV4Gateway(f.context);
  try {
    await assert.rejects(
      gateway.rowsRange({ sessionId: f.sessionId, limit: 20, clientMode: "desktop-continuous" }),
      /fixture history read failed/,
    );
  } finally {
    gateway.dispose();
  }
});
