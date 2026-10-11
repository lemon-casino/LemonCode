import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { type FSWatcher, type watch } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileWatcherService } from "./fileWatcherService.js";

test(
  "checkout release drains a watch admitted before the deletion fence and waits for its close",
  { timeout: 5_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "lcode-watch-admission-"));
    const child = join(root, "child");
    await mkdir(child);
    const admission = Promise.withResolvers<void>();
    let calls = 0;
    let closes = 0;
    const watcher = Object.assign(new EventEmitter(), {
      close: () => {
        closes++;
      },
    });
    const service = createFileWatcherService({
      assertWatchAllowed: async () => {
        calls++;
        await admission.promise;
      },
      watch: (() => watcher as unknown as FSWatcher) as typeof watch,
    });
    t.after(async () => {
      admission.resolve();
      service.disposeAll();
      watcher.emit("close");
      await rm(root, { recursive: true, force: true });
    });
    const opening = service.watch({ path: child });
    assert.equal(calls, 1);
    let released = false;
    const stopping = service.stopPathAndWait(root).then(() => {
      released = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(released, false, "pending admission must be part of the release barrier");
    admission.resolve();
    const id = await opening;
    while (!closes) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(released, false, "close() is not a native close receipt");
    watcher.emit("close");
    await stopping;
    await service.unwatch(id);
    assert.equal(closes, 1);
  },
);

test("rejected or disposed watch admissions never open a native handle", async () => {
  const admission = Promise.withResolvers<void>();
  let opens = 0;
  const service = createFileWatcherService({
    assertWatchAllowed: () => admission.promise,
    watch: (() => {
      opens++;
      throw new Error("unexpected native watch");
    }) as typeof watch,
  });
  const opening = service.watch({ path: tmpdir() });
  const rejected = assert.rejects(opening, /fenced/);
  admission.reject(new Error("worktree file watch admission is fenced"));
  await rejected;
  await service.stopPathAndWait(tmpdir());
  service.disposeAll();
  assert.equal(opens, 0);

  const delayed = Promise.withResolvers<void>();
  const disposing = createFileWatcherService({
    assertWatchAllowed: () => delayed.promise,
    watch: (() => {
      opens++;
      throw new Error("unexpected native watch");
    }) as typeof watch,
  });
  const pending = disposing.watch({ path: tmpdir() });
  disposing.disposeAll();
  delayed.resolve();
  await assert.rejects(pending, /disposed/);
  assert.equal(opens, 0);
});
