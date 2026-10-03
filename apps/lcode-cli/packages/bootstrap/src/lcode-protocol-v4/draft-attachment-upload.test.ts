import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { AttachmentUploadRegistry } from "./attachment-upload-registry.js";
import { attachmentBegin } from "./v4-gateway-attachments.js";
import { v4AttachmentBeginParamsSchema } from "@lcode/shared/lcode-protocol-v4";

const bytes = new TextEncoder().encode("pasted image");
const input = {
  connectionId: "desktop", draftId: "draft-1", uploadId: "upload-1",
  fileName: "image.png", mime: "image/png", totalBytes: bytes.length,
  totalChunks: 1, checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
};
test("草稿附件无需会话：上传进度、幂等提交及 target 隔离", async () => {
  let writes = 0;
  const registry = new AttachmentUploadRegistry({
    now: () => 0,
    putSessionAttachment: async () => { throw new Error("must not create or resume session"); },
    putDraftAttachment: async (draftId) => { writes++; return { ref: `artifact://${draftId}` }; },
  });
  assert.equal(registry.begin(input).nextChunkIndex, 0);
  assert.equal(registry.chunk({ ...input, chunkIndex: 0, dataBase64: Buffer.from(bytes).toString("base64") }).nextChunkIndex, 1);
  assert.deepEqual(await registry.commit(input), { ref: "artifact://draft-1" });
  assert.deepEqual(await registry.commit(input), { ref: "artifact://draft-1" });
  assert.equal(writes, 1);
  const { draftId: _, ...sessionInput } = input;
  assert.equal(registry.begin({ ...sessionInput, sessionId: input.draftId }).state, "staging");
});
test("草稿 begin 不调用 cold resume", async () => {
  const registry = new AttachmentUploadRegistry({ now: () => 0, putSessionAttachment: async () => ({ ref: "unused" }), putDraftAttachment: async () => ({ ref: "draft" }) });
  let resumes = 0;
  const gateway = { attachmentUploads: registry, coldResume: { ensureResumed: async () => { resumes++; } }, host: { putDraftAttachment: async () => ({ ref: "draft" }), sessionExists: () => false } };
  await attachmentBegin(gateway as unknown as Parameters<typeof attachmentBegin>[0], input);
  assert.equal(resumes, 0);
});
test("上传 target 必须且只能选择 session 或 draft", () => {
  assert.equal(v4AttachmentBeginParamsSchema.safeParse(input).success, true);
  assert.equal(v4AttachmentBeginParamsSchema.safeParse({ ...input, sessionId: "session" }).success, false);
  const { draftId: _, ...missing } = input;
  assert.equal(v4AttachmentBeginParamsSchema.safeParse(missing).success, false);
});
