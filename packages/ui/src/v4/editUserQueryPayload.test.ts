import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSelection } from "@lcode/shared";
import type { AttachmentRef } from "@lcode/shared/lcode-protocol-v4";
import { buildEditUserQueryPayload } from "./editUserQueryPayload.js";

const modelSelection: ModelSelection = {
  providerId: "provider-b",
  modelId: "model-b",
  options: { reasoningLevel: "high", speed: "fast" },
};
const attachment: AttachmentRef = {
  ref: "lcode-attachment://file-1",
  fileName: "notes.txt",
  mime: "text/plain",
  bytes: 12,
};

test("edit payload freezes the current model selection alongside edit fields", () => {
  const attachments = [attachment];
  const payload = buildEditUserQueryPayload({
    target: { rowId: 7, entityId: "user-7" },
    newText: "edited prompt",
    attachments,
    modelSelection,
    workspaceMode: "rewind",
  });

  assert.deepEqual(payload, {
    target: { rowId: 7, entityId: "user-7" },
    newText: "edited prompt",
    attachments: [attachment],
    modelSelection,
    workspaceMode: "rewind",
  });
  assert.notEqual(payload.attachments, attachments);
  assert.deepEqual(payload.modelSelection.options, {
    reasoningLevel: "high",
    speed: "fast",
  });
});

test("edit payload preserves an explicit empty attachment list", () => {
  const payload = buildEditUserQueryPayload({
    target: { rowId: 7, entityId: "user-7" },
    newText: "remove files",
    attachments: [],
    modelSelection,
    workspaceMode: "preserve",
  });

  assert.deepEqual(payload.attachments, []);
  assert.notEqual(payload.attachments, undefined);
});
