import assert from "node:assert/strict";
import test from "node:test";
import type { FileSystemPort } from "@lcode/contracts";
import { refreshProjectMemoryIndex } from "./project-memory-index-refresh.js";

const fake = (read: () => Promise<unknown>) => ({
  memoryRoot: "/memory",
  memoryIndexContent: "old",
  fileSystemPort: { readTextFile: read } as unknown as FileSystemPort,
});

test("next turn refresh observes externally edited MEMORY.md without using mtime", async () => {
  const runtime = fake(async () => ({ content: "new index", truncated: false }));
  await refreshProjectMemoryIndex(runtime);
  assert.equal(runtime.memoryIndexContent, "new index");
});

test("deleted or unreadable index does not keep stale context", async () => {
  const runtime = fake(async () => {
    throw new Error("private path");
  });
  await refreshProjectMemoryIndex(runtime);
  assert.equal(runtime.memoryIndexContent, undefined);
});

test("empty and truncated index do not silently claim a complete index", async () => {
  const runtime = fake(async () => ({ content: "prefix", truncated: true }));
  await refreshProjectMemoryIndex(runtime);
  assert.match(runtime.memoryIndexContent!, /partially loaded/u);
  runtime.fileSystemPort = {
    readTextFile: async () => ({ content: "", truncated: false }),
  } as unknown as FileSystemPort;
  await refreshProjectMemoryIndex(runtime);
  assert.equal(runtime.memoryIndexContent, undefined);
});

test("cancelled refresh retains the previous snapshot and throws", async () => {
  const controller = new AbortController();
  const runtime = fake(async () => {
    controller.abort();
    return { content: "late", truncated: false };
  });
  await assert.rejects(refreshProjectMemoryIndex(runtime, controller.signal));
  assert.equal(runtime.memoryIndexContent, "old");
});
