import assert from "node:assert/strict";
import test from "node:test";
import { resolveTurnAttachments } from "./attachments.js";

test("directory path is usable model context without a read failure", async () => {
  const options = {
    workingDirectory: "/workspace",
    traceContext: { traceId: "fixture" },
    fileSystemPort: {
      stat: async () => ({ kind: "directory", sizeBytes: 0 }),
      readTextFile: async () => {
        throw new Error("directory must not be read as a file");
      },
    },
  } as unknown as Parameters<typeof resolveTurnAttachments>[1];
  const [result] = await resolveTurnAttachments(
    [{ type: "file", path: "/fixture/folder" }],
    options,
  );
  assert.equal(result!.metadata?.errorCode, undefined);
  assert.equal(result!.metadata?.storageKind, "local_ref");
  assert.equal(result!.mime, "inode/directory");
  assert.match(JSON.stringify(result!.contentBlock), /directory/);
  assert.match(JSON.stringify(result!.contentBlock), /\/fixture\/folder/);
});
