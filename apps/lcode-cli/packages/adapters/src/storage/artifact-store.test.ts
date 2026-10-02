import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionId, ToolCallId } from "@lcode/contracts";
import { createNodeToolArtifactStore, NodeToolArtifactStore } from "./index.js";

test("artifact codecs preserve binary/text serialization and media singleflight ownership", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-artifact-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createNodeToolArtifactStore({
    rootDir: join(directory, "artifacts"),
    imageCacheRootDir: join(directory, "images"),
    videoCacheRootDir: join(directory, "videos"),
  });
  assert.ok(store.writeToolResultBinaryArtifact);
  assert.ok(store.readToolResultBinaryArtifact);
  assert.ok(store.ensureMediaAttachmentPath);
  const sessionId = "fixture-session" as SessionId;
  const binary = await store.writeToolResultBinaryArtifact({
    sessionId,
    toolCallId: "call" as ToolCallId,
    toolName: "fixture",
    content: new Uint8Array([0, 255, 42]),
    contentType: "application/octet-stream",
    extension: ".xlsx",
  });
  const readBack = await store.readToolResultArtifact({ uri: binary.uri });
  assert.equal(readBack.contentType, "application/octet-stream");
  assert.equal(readBack.content, "AP8q");
  assert.deepEqual(
    (await store.readToolResultBinaryArtifact({ uri: binary.uri })).bytes,
    new Uint8Array([0, 255, 42]),
  );
  const text = await store.writeToolResultArtifact({
    sessionId,
    toolCallId: "text" as ToolCallId,
    toolName: "fixture",
    content: '{"ok":true}',
  });
  assert.equal((await store.readToolResultArtifact({ uri: text.uri })).content, '{"ok":true}');
  const pdfBytes = Buffer.from("%PDF-fixture");
  const pdf = await store.writeToolResultArtifact({
    sessionId,
    toolCallId: "pdf" as ToolCallId,
    toolName: "fixture",
    content: `data:application/pdf;base64,${pdfBytes.toString("base64")}`,
  });
  const first = store.ensureMediaAttachmentPath({ uri: pdf.uri, mediaType: "application/pdf" });
  const second = store.ensureMediaAttachmentPath({ uri: pdf.uri, mediaType: "application/pdf" });
  assert.equal(first, second);
  const materialized = await first;
  assert.equal(materialized.status, "ready");
  if (materialized.status === "ready") {
    assert.deepEqual(await readFile(materialized.path), pdfBytes);
    assert.equal(materialized.path.startsWith(join(directory, "pdf-cache")), true);
  }
  await assert.rejects(
    store.readToolResultArtifact({ uri: "https://example.invalid/artifact" }),
    /Unsupported tool artifact URI/,
  );
  assert.equal(NodeToolArtifactStore.length, 1);
  assert.equal(createNodeToolArtifactStore.length, 1);
});
