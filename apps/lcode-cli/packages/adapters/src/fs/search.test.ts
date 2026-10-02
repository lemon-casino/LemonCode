import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import { isFileSystemPortError } from "@lcode/contracts";
import {
  createNodeFileSystemAdapter,
  setRipgrepTimeoutMsForTests,
  setRipgrepWorkerFactoryForTests,
} from "./index.js";

test("file search preserves glob rules, VCS exclusion, ordering and pagination", async (t) => {
  const directory = await fixtureDirectory(t);
  const oldPath = join(directory, "old.ts");
  const newPath = join(directory, "new.ts");
  await writeFile(oldPath, "old");
  await writeFile(newPath, "new");
  await utimes(oldPath, new Date(1_000), new Date(1_000));
  await utimes(newPath, new Date(2_000), new Date(2_000));
  await mkdir(join(directory, ".git"));
  await writeFile(join(directory, ".git", "hidden.ts"), "ignored");
  const adapter = createNodeFileSystemAdapter();
  const first = await adapter.searchFiles({ path: directory, pattern: "**/*.ts", maxResults: 1 });
  assert.deepEqual(first.files, [newPath]);
  assert.equal(first.truncated, true);
  const second = await adapter.searchFiles({ path: directory, pattern: "*.{ts,js}", offset: 1 });
  assert.deepEqual(second.files, [oldPath]);
  assert.equal(second.truncated, false);
});

test("JavaScript search preserves count, matching context, multiline and head limits", async (t) => {
  const directory = await fixtureDirectory(t);
  const path = join(directory, "example.ts");
  await writeFile(path, "before\nhello hello\nafter\nhello\n");
  await writeFile(join(directory, "binary.ts"), "hello\0hello");
  await writeFile(join(directory, "excluded.txt"), "hello");
  const adapter = createNodeFileSystemAdapter({ textSearchEngine: "javascript" });
  const count = await adapter.searchText({
    path: directory,
    pattern: "hello",
    type: "ts",
    outputMode: "count",
  });
  assert.deepEqual(count.entries, [{ path, count: 2 }]);
  assert.equal(count.numMatches, 2);
  const context = await adapter.searchText({
    path,
    pattern: "hello",
    outputMode: "content",
    onlyMatching: true,
    context: 1,
  });
  assert.deepEqual(
    context.entries.map(({ lineNumber, text, matched }) => ({ lineNumber, text, matched })),
    [
      { lineNumber: 1, text: "before", matched: false },
      { lineNumber: 2, text: "hello", matched: true },
      { lineNumber: 2, text: "hello", matched: true },
      { lineNumber: 3, text: "after", matched: false },
      { lineNumber: 4, text: "hello", matched: true },
    ],
  );
  const multiline = await adapter.searchText({
    path,
    pattern: "hello\\nafter",
    multiline: true,
    onlyMatching: true,
    outputMode: "content",
  });
  assert.deepEqual(
    multiline.entries.map((entry) => entry.text),
    ["hello", "after"],
  );
  assert.equal(multiline.numMatches, 1);
  const limited = await adapter.searchText({
    path,
    pattern: "hello",
    outputMode: "content",
    headLimit: 1,
    offset: 1,
  });
  assert.equal(limited.entries[0]?.lineNumber, 4);
  assert.equal(limited.appliedOffset, 1);
  const unlimited = await adapter.searchText({
    path,
    pattern: "hello",
    outputMode: "content",
    headLimit: 0,
  });
  assert.equal(unlimited.entries.length, 2);
  assert.equal(unlimited.truncated, false);
  await assert.rejects(adapter.searchText({ path, pattern: "[" }), hasCode("invalid_pattern"));
  await assert.rejects(
    adapter.searchText({ path, pattern: "hello" }, { signal: AbortSignal.abort() }),
    hasCode("cancelled"),
  );
});

test("ripgrep worker keeps JSON parsing and count results through original test seams", async (t) => {
  const directory = await fixtureDirectory(t);
  const path = join(directory, "example.ts");
  await writeFile(path, "hello hello\n");
  let args: string[] = [];
  t.after(
    setRipgrepWorkerFactoryForTests((data) => {
      args = data.args;
      const worker = new FakeWorker();
      queueMicrotask(() =>
        worker.emit("message", {
          type: "result",
          result: {
            code: 0,
            stderr: "",
            stdout: data.args.includes("--json")
              ? JSON.stringify({
                  type: "match",
                  data: {
                    path: { text: "./example.ts" },
                    line_number: 1,
                    lines: { text: "hello hello\n" },
                    submatches: [{ match: { text: "hello" } }, { match: { text: "hello" } }],
                  },
                }) + "\n"
              : "./example.ts:2\n",
          },
        }),
      );
      return worker;
    }),
  );
  const adapter = createNodeFileSystemAdapter();
  const content = await adapter.searchText({
    path: directory,
    pattern: "hello",
    outputMode: "content",
    onlyMatching: true,
  });
  assert.deepEqual(
    content.entries.map((entry) => entry.text),
    ["hello", "hello"],
  );
  assert.deepEqual(content.files, [path]);
  assert.ok(args.includes("--only-matching"));
  assert.ok(args.includes("!**/.git/**"));
  const count = await adapter.searchText({
    path: directory,
    pattern: "hello",
    outputMode: "count",
  });
  assert.deepEqual(count.entries, [{ path, count: 2 }]);
});

test("ripgrep runtime errors fall back but timeout remains an error and terminates worker", async (t) => {
  const directory = await fixtureDirectory(t);
  const path = join(directory, "example.ts");
  await writeFile(path, "needle\n");
  const restoreFactory = setRipgrepWorkerFactoryForTests(() => {
    throw new Error("worker unavailable");
  });
  try {
    assert.deepEqual(
      (await createNodeFileSystemAdapter().searchText({ path, pattern: "needle" })).files,
      [path],
    );
  } finally {
    restoreFactory();
  }
  const worker = new FakeWorker();
  t.after(setRipgrepWorkerFactoryForTests(() => worker));
  t.after(setRipgrepTimeoutMsForTests(1));
  await assert.rejects(
    createNodeFileSystemAdapter().searchText({ path, pattern: "needle" }),
    /timed out/,
  );
  assert.equal(worker.terminationCount, 1);
});

test("ripgrep worker port accepts a real Node Worker without unrelated capabilities", async (t) => {
  const directory = await fixtureDirectory(t);
  const path = join(directory, "example.ts");
  await writeFile(path, "needle\n");
  t.after(
    setRipgrepWorkerFactoryForTests(
      () =>
        new Worker(
          `
      const { parentPort } = require("node:worker_threads");
      parentPort.postMessage({
        type: "result",
        result: { code: 0, stderr: "", stdout: "./example.ts:1\\n" },
      });
    `,
          { eval: true },
        ),
    ),
  );
  const result = await createNodeFileSystemAdapter().searchText({ path, pattern: "needle" });
  assert.deepEqual(result.files, [path]);
  assert.equal(result.numMatches, 1);
});

test("ripgrep in-flight cancellation terminates the narrow worker port once", async (t) => {
  const directory = await fixtureDirectory(t);
  const path = join(directory, "example.ts");
  await writeFile(path, "needle\n");
  const started = Promise.withResolvers<void>();
  const worker = new FakeWorker();
  t.after(
    setRipgrepWorkerFactoryForTests(() => {
      started.resolve();
      return worker;
    }),
  );
  const controller = new AbortController();
  const result = createNodeFileSystemAdapter().searchText(
    { path, pattern: "needle" },
    { signal: controller.signal },
  );
  const rejected = assert.rejects(result, hasCode("cancelled"));
  await started.promise;
  controller.abort();
  await rejected;
  assert.equal(worker.terminationCount, 1);
});

class FakeWorker extends EventEmitter {
  terminationCount = 0;
  async terminate(): Promise<number> {
    this.terminationCount += 1;
    return 0;
  }
}

async function fixtureDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lcode-search-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => isFileSystemPortError(error) && error.code === code;
}
