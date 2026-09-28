import assert from "node:assert/strict";
import test from "node:test";

import { v4AttachmentBeginParamsSchema } from "./transport.js";

const validAttachmentBegin = {
  connectionId: "connection-1",
  uploadId: "upload-1",
  sessionId: "session-1",
  fileName: "screenshot.png",
  mime: "image/png",
  totalBytes: 0,
  totalChunks: 0,
  checksum: `sha256:${"0".repeat(64)}`,
};

test("attachment begin accepts an ordinary filename", () => {
  assert.equal(v4AttachmentBeginParamsSchema.safeParse(validAttachmentBegin).success, true);
});

test("attachment begin rejects NUL, CR and LF in filenames", () => {
  for (const controlCharacter of ["\u0000", "\r", "\n"]) {
    assert.equal(
      v4AttachmentBeginParamsSchema.safeParse({
        ...validAttachmentBegin,
        fileName: `screen${controlCharacter}shot.png`,
      }).success,
      false,
    );
  }
});
