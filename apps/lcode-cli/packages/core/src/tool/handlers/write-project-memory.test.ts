import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  createFileSystemError,
  EditErrorCode,
  type FileSystemOperationOptions,
  type FileSystemPort,
  type FileSystemReadTextResult,
  type FileSystemWriteTextRequest,
} from "@lcode/contracts";
import { createReadFileStateKey } from "../read-file-state.js";
import type { ToolExecutionContext } from "../types.js";
import { writeToolEntry } from "./write.js";
import { editToolEntry } from "./edit.js";

const ROOT = resolve("write-memory-fixture");
const FILE = join(ROOT, "preference.md");

function context(fileSystemPort: FileSystemPort): ToolExecutionContext {
  return {
    toolCallId: "write-fixture",
    sessionId: "session-fixture",
    traceId: "trace-fixture",
    workingDirectory: ROOT,
    workspaceRoot: ROOT,
    runtimeScope: "main",
    fileSystemPort,
    readFileState: new Map(),
  } as ToolExecutionContext;
}

function missing() {
  return createFileSystemError({ code: "not_found", path: FILE, message: "fixture missing" });
}

test("Write marks a not_found read as expectedMissing and propagates trace/cancellation", async () => {
  let request: FileSystemWriteTextRequest | undefined;
  const controller = new AbortController();
  const ctx = context({
    async readTextFile(_request: unknown, options?: FileSystemOperationOptions) {
      assert.equal(options?.signal, controller.signal);
      throw missing();
    },
    async writeTextFile(input: FileSystemWriteTextRequest, options?: FileSystemOperationOptions) {
      request = input;
      assert.equal(options?.signal, controller.signal);
      return { path: input.path, bytesWritten: input.content.length };
    },
  } as FileSystemPort);
  ctx.abortSignal = controller.signal;
  await writeToolEntry.handler({ file_path: FILE, content: "new preference" }, ctx);
  assert.equal(request?.expectedMissing, true);
  assert.equal(request?.expectedRevision, undefined);
  assert.equal(request?.trace?.traceId, ctx.traceId);
});

test("Write passes the full original CRLF revision hash without hashing normalized text", async () => {
  const revision = {
    id: "fixture-revision",
    hash: `sha256:${"a".repeat(64)}`,
    mtimeMs: 1,
    sizeBytes: 8,
  };
  const read: FileSystemReadTextResult = {
    path: FILE,
    content: "before\n",
    encoding: "utf8",
    lineEndings: "CRLF",
    bytesRead: 8,
    sizeBytes: 8,
    truncated: false,
    revision,
  };
  let request: FileSystemWriteTextRequest | undefined;
  const ctx = context({
    readTextFile: async () => read,
    writeTextFile: async (input: FileSystemWriteTextRequest) => {
      request = input;
      return { path: input.path, bytesWritten: input.content.length };
    },
  } as FileSystemPort);
  ctx.readFileState!.set(createReadFileStateKey(FILE, 1, undefined), {
    path: FILE,
    content: read.content,
    readAt: new Date(0),
    revisionId: revision.id,
    mtimeMs: 1,
    sizeBytes: 8,
    isPartialView: false,
  });
  await writeToolEntry.handler({ file_path: FILE, content: "after\n" }, ctx);
  assert.equal(request?.expectedRevision, revision);
  assert.equal(request?.expectedMissing, undefined);
  assert.equal(request?.lineEndings, "CRLF");
});

test("a create race rejects stale_write without retrying or recording a successful write", async () => {
  let calls = 0;
  let current = "created by another writer";
  const conflict = createFileSystemError({
    code: "stale_write",
    path: FILE,
    message: "fixture race",
  });
  const ctx = context({
    readTextFile: async () => {
      throw missing();
    },
    writeTextFile: async (input: FileSystemWriteTextRequest) => {
      calls += 1;
      if (input.expectedMissing) throw conflict;
      current = input.content;
      return { path: FILE, bytesWritten: current.length };
    },
  } as FileSystemPort);
  await assert.rejects(
    writeToolEntry.handler({ file_path: FILE, content: "overwrite" }, ctx),
    (error) => error === conflict,
  );
  assert.equal(current, "created by another writer");
  assert.equal(calls, 1);
  assert.equal(ctx.readFileState!.size, 0);
});

test("not_found during the write itself is not mistaken for permission to retry a create", async () => {
  let calls = 0;
  const error = missing();
  const ctx = context({
    readTextFile: async () => {
      throw missing();
    },
    writeTextFile: async () => {
      calls += 1;
      throw error;
    },
  } as unknown as FileSystemPort);
  await assert.rejects(
    writeToolEntry.handler({ file_path: FILE, content: "new" }, ctx),
    (cause) => cause === error,
  );
  assert.equal(calls, 1);
  assert.equal(ctx.readFileState!.size, 0);
});

function sameRevisionFixture() {
  let content = "keep alpha";
  let writes = 0;
  const revision = { id: "same-stat-id", mtimeMs: 1000, sizeBytes: content.length };
  const ctx = context({
    stat: async () => ({ path: FILE, kind: "file", sizeBytes: content.length, revision }),
    readTextFile: async () => ({
      path: FILE,
      content,
      encoding: "utf8",
      bytesRead: content.length,
      sizeBytes: content.length,
      truncated: false,
      revision: { ...revision, hash: `raw:${content}` },
    }),
    writeTextFile: async (request: FileSystemWriteTextRequest) => {
      writes += 1;
      content = request.content;
      return { path: FILE, bytesWritten: content.length, revision };
    },
  } as FileSystemPort);
  ctx.readFileState!.set(createReadFileStateKey(FILE, 1, undefined), {
    path: FILE,
    content,
    readAt: new Date(0),
    revisionId: revision.id,
    mtimeMs: revision.mtimeMs,
    sizeBytes: revision.sizeBytes,
    isPartialView: false,
  });
  return {
    ctx,
    setContent: (value: string) => {
      content = value;
    },
    content: () => content,
    writes: () => writes,
  };
}

test("Write rejects unseen full-read content even when external editing preserves mtime, size and revision id", async () => {
  const h = sameRevisionFixture();
  h.setContent("keep bravo");
  await assert.rejects(
    writeToolEntry.handler({ file_path: FILE, content: "keep gamma" }, h.ctx),
    /modified since read/u,
  );
  assert.equal(h.content(), "keep bravo");
  assert.equal(h.writes(), 0);
});

test("Edit rejects unseen full-read content even when external editing preserves mtime, size and revision id", async () => {
  const h = sameRevisionFixture();
  h.setContent("keep bravo");
  const result = await editToolEntry.handler(
    { file_path: FILE, old_string: "keep", new_string: "want" },
    h.ctx,
  );
  assert.equal((result as { errorCode?: number }).errorCode, EditErrorCode.STALE_FILE);
  assert.equal(h.content(), "keep bravo");
  assert.equal(h.writes(), 0);
});

test("consecutive Write/Edit successes refresh the same read state without false stale rejections", async () => {
  const h = sameRevisionFixture();
  await writeToolEntry.handler({ file_path: FILE, content: "keep bravo" }, h.ctx);
  const edited = await editToolEntry.handler(
    { file_path: FILE, old_string: "bravo", new_string: "gamma" },
    h.ctx,
  );
  assert.equal("errorCode" in (edited as object), false);
  await writeToolEntry.handler({ file_path: FILE, content: "keep delta" }, h.ctx);
  assert.equal(h.content(), "keep delta");
  assert.equal(h.writes(), 3);
});

test("line-ending-only differences in full read state do not reject subsequent Write/Edit", async () => {
  const h = sameRevisionFixture();
  h.setContent("keep alpha\n");
  const cached = h.ctx.readFileState!.get(createReadFileStateKey(FILE, 1, undefined))!;
  cached.content = "keep alpha\r\n";
  cached.sizeBytes = 12;
  await writeToolEntry.handler({ file_path: FILE, content: "keep bravo\n" }, h.ctx);
  const written = h.ctx.readFileState!.get(createReadFileStateKey(FILE, 1, undefined))!;
  written.content = "keep bravo\r\n";
  const edited = await editToolEntry.handler(
    { file_path: FILE, old_string: "bravo", new_string: "gamma" },
    h.ctx,
  );
  assert.equal("errorCode" in (edited as object), false);
  assert.equal(h.content(), "keep gamma\n");
  assert.equal(h.writes(), 2);
});

test("non-not_found read failures never permit writes", async () => {
  const error = createFileSystemError({
    code: "permission_denied",
    path: FILE,
    message: "fixture denied",
  });
  const ctx = context({
    readTextFile: async () => {
      throw error;
    },
    writeTextFile: async () => {
      throw new Error("must not write");
    },
  } as unknown as FileSystemPort);
  await assert.rejects(
    writeToolEntry.handler({ file_path: FILE, content: "new" }, ctx),
    (cause) => cause === error,
  );
});
