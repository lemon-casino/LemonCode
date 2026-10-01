import assert from "node:assert/strict";
import test from "node:test";
import { structuredPatch } from "diff";
import { resolveWorkspaceCheckpointAfterContent } from "./checkpoint-file-content.js";

test("Edit 只有 structuredPatch 时精确重放 LF/CRLF/无末尾换行，不用模糊匹配猜 after", () => {
  for (const [before, after] of [
    ["a\nb\n", "A\nb\n"],
    ["a\r\nb\r\n", "A\r\nb\r\n"],
    ["old", "new"],
  ]) {
    const file = {
      path: "x.ts",
      existedBefore: true,
      beforeContent: before!,
      structuredPatch: structuredPatch("x.ts", "x.ts", before!, after!).hunks,
    };
    assert.equal(resolveWorkspaceCheckpointAfterContent(file), after);
    assert.equal(
      resolveWorkspaceCheckpointAfterContent({ ...file, beforeContent: "unrelated" }),
      undefined,
    );
  }
});
