import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  createFileSystemError,
  type FileSystemOperationOptions,
  type FileSystemPort,
  type FileSystemReadTextResult,
  type FileSystemWriteTextRequest,
} from "@lcode/contracts";
import { createReadFileStateKey } from "../read-file-state.js";
import type { ToolExecutionContext } from "../types.js";
import { editToolEntry } from "./edit.js";

const ROOT = resolve("edit-memory-fixture");
const FILE = join(ROOT, "preference.md");

function context(fileSystemPort: FileSystemPort): ToolExecutionContext {
  return {
    toolCallId: "edit-fixture",
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

test("Edit creation after missing stat requires expectedMissing and preserves cancellation/trace", async () => {
  let request: FileSystemWriteTextRequest | undefined;
  const controller = new AbortController();
  const ctx = context({
    async stat(_input: unknown, options?: FileSystemOperationOptions) {
      assert.equal(options?.signal, controller.signal);
      throw missing();
    },
    async readTextFile() {
      throw new Error("creation must not read absent file");
    },
    async writeTextFile(input: FileSystemWriteTextRequest, options?: FileSystemOperationOptions) {
      assert.equal(options?.signal, controller.signal);
      request = input;
      if (!input.expectedMissing) {
        throw createFileSystemError({ code: "stale_write", message: "expectedMissing required" });
      }
      return { path: input.path, bytesWritten: input.content.length };
    },
  } as unknown as FileSystemPort);
  ctx.abortSignal = controller.signal;
  await editToolEntry.handler(
    { file_path: FILE, old_string: "", new_string: "new preference" },
    ctx,
  );
  assert.equal(request?.expectedMissing, true);
  assert.equal(request?.expectedRevision, undefined);
  assert.equal(request?.trace?.traceId, ctx.traceId);
  assert.equal(ctx.readFileState!.size, 1);
});

test("Edit creation race does not overwrite a file created after the missing stat", async () => {
  const conflict = createFileSystemError({
    code: "stale_write",
    path: FILE,
    message: "fixture race",
  });
  let current = "another writer's content";
  let writes = 0;
  const ctx = context({
    stat: async () => {
      throw missing();
    },
    writeTextFile: async (request: FileSystemWriteTextRequest) => {
      writes += 1;
      if (request.expectedMissing) throw conflict;
      current = request.content;
      return { path: request.path, bytesWritten: request.content.length };
    },
  } as unknown as FileSystemPort);
  await assert.rejects(
    editToolEntry.handler({ file_path: FILE, old_string: "", new_string: "overwrite" }, ctx),
    (error) => error === conflict,
  );
  assert.equal(current, "another writer's content");
  assert.equal(writes, 1);
  assert.equal(ctx.readFileState!.size, 0);
});

test("Edit replacement retains the full read revision and never requests missing semantics", async () => {
  const revision = {
    id: "fixture-revision",
    hash: `sha256:${"b".repeat(64)}`,
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
    stat: async () => ({ path: FILE, kind: "file", sizeBytes: 8 }),
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
  await editToolEntry.handler({ file_path: FILE, old_string: "before", new_string: "after" }, ctx);
  assert.equal(request?.expectedRevision, revision);
  assert.equal(request?.expectedMissing, undefined);
  assert.equal(request?.lineEndings, "CRLF");
});

test("Edit does not reinterpret write-stage not_found as a new create attempt", async () => {
  let writes = 0;
  const error = missing();
  const ctx = context({
    stat: async () => {
      throw missing();
    },
    writeTextFile: async () => {
      writes += 1;
      throw error;
    },
  } as unknown as FileSystemPort);
  await assert.rejects(
    editToolEntry.handler({ file_path: FILE, old_string: "", new_string: "new preference" }, ctx),
    (cause) => cause === error,
  );
  assert.equal(writes, 1);
  assert.equal(ctx.readFileState!.size, 0);
});
