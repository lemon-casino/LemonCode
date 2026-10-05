import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileWatcherService } from "./fileWatcherService.js";

test("真实文件持续写入时 watcher 在批次结束前发出事件，释放后停止广播", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "lcode-live-watch-"));
  const service = createFileWatcherService();
  t.after(async () => {
    service.disposeAll();
    await rm(dir, { recursive: true, force: true });
  });
  const { id } = await service.watch({ path: dir });
  let writing = true;
  let duringBatch = 0;
  let events = 0;
  const off = service.onDynamicChange(id)(() => {
    events++;
    if (writing) duringBatch++;
  });
  const start = Date.now();
  while (Date.now() - start < 1_200) {
    await writeFile(join(dir, "a.txt"), String(Date.now()));
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  writing = false;
  assert.ok(duringBatch > 0, "continuous writes must not postpone every event until quiet");
  off.dispose();
  await service.unwatch({ id });
  const before = events;
  await writeFile(join(dir, "a.txt"), "after unwatch");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(events, before);
});
