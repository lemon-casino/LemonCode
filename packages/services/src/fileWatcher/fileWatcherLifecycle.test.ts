import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { type FSWatcher, type watch } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileWatcherService, createPublicFileWatcherService } from "./fileWatcherService.js";

test("checkout shutdown waits for all watcher close receipts and keeps outside and redirected watchers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lcode-watch-close-"));
  const checkout = join(root, "checkout");
  const child = join(checkout, "packages");
  const outside = join(root, "checkout-other");
  await mkdir(child, { recursive: true });
  await mkdir(outside);
  const linked = join(checkout, "linked");
  await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
  const watches: (EventEmitter & { closes: number; close(): void })[] = [];
  const service = createFileWatcherService({
    watch: (() => {
      const watcher = Object.assign(new EventEmitter(), {
        closes: 0,
        close() {
          this.closes++;
        },
      });
      watches.push(watcher);
      return watcher as unknown as FSWatcher;
    }) as typeof watch,
  });
  t.after(async () => {
    service.disposeAll();
    watches.forEach((watcher) => watcher.emit("close"));
    await rm(root, { recursive: true, force: true });
  });
  const ids = await Promise.all(
    [checkout, child, outside, linked].map((path) => service.watch({ path })),
  );
  let finished = false;
  const stopping = service.stopPathAndWait(checkout).then(() => {
    finished = true;
  });
  // 异步 canonical 读取返回后，已发出 close 请求的句柄仍不能被当作已释放。
  while (watches[0]!.closes === 0 || watches[1]!.closes === 0)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  assert.deepEqual(
    watches.map((watcher) => watcher.closes),
    [1, 1, 0, 0],
  );
  watches[0]!.emit("close");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  watches[1]!.emit("close");
  await stopping;
  await service.unwatch(ids[0]!);
  assert.deepEqual(
    Object.keys(createPublicFileWatcherService(service)).sort(),
    ["watch", "unwatch", "disposeAll", "onDynamicChange"].sort(),
  );
});
