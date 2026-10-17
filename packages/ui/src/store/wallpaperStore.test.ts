import assert from "node:assert/strict";
import { test } from "node:test";
import { createWallpaperStore, type WallpaperRecord } from "./wallpaperStore.js";
import { WALLPAPER_SOURCES } from "./wallpaperStorage.js";

test("已删除的壁纸来源回到关闭，保留有效图片并复用原写入路径", async () => {
  assert.deepEqual(WALLPAPER_SOURCES, ["none", "baili", "aemeath", "custom"]);
  const image = new Blob(["image"], { type: "image/png" });
  const writes: WallpaperRecord[] = [];
  const store = createWallpaperStore({
    read: async () => ({ source: "dragon", image }) as unknown as WallpaperRecord,
    write: async (record) => {
      writes.push(record);
    },
  });
  await store.getState().initialize();
  assert.deepEqual(store.getState().record, { source: "none", image });
  assert.equal(writes.length, 0);
  await store.getState().select("custom");
  assert.deepEqual(writes, [{ source: "custom", image }]);
});

test("慢解码按命令顺序保存，不覆盖后来的选择；解码错误保留旧壁纸", async () => {
  let release!: () => void;
  const decoding = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writes: string[] = [];
  const store = createWallpaperStore(
    {
      read: async () => ({ source: "none" }),
      write: async (record) => {
        writes.push(record.source);
      },
    },
    () => decoding,
  );
  const importing = store.getState().importImage(new Blob(["image"], { type: "image/png" }));
  const selecting = store.getState().select("baili");
  assert.equal(store.getState().busy, true);
  release();
  await Promise.all([importing, selecting]);
  assert.deepEqual(writes, ["custom", "baili"]);
  assert.equal(store.getState().record.source, "baili");
  const broken = createWallpaperStore(
    { read: async () => ({ source: "none" }), write: async () => assert.fail() },
    async () => {
      throw new Error("decode");
    },
  );
  assert.equal(
    await broken.getState().importImage(new Blob(["broken"], { type: "image/png" })),
    false,
  );
  assert.equal(broken.getState().record.source, "none");
});

test("壁纸初始化先于写入，串行保存的最后选择胜出", async () => {
  let release!: (value: WallpaperRecord) => void;
  const writes: string[] = [];
  const store = createWallpaperStore({
    read: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    write: async (record) => {
      writes.push(record.source);
    },
  });
  const first = store.getState().select("baili");
  const last = store.getState().select("none");
  release({ source: "none" });
  await Promise.all([first, last]);
  assert.deepEqual(writes, ["baili", "none"]);
  assert.equal(store.getState().record.source, "none");
});

test("保存失败不替换当前壁纸；关闭保留图片以便重选", async () => {
  const image = new Blob(["image"], { type: "image/png" });
  let fail = false;
  const store = createWallpaperStore({
    read: async () => ({ source: "custom", image }),
    write: async () => {
      if (fail) throw new Error("quota");
    },
  });
  await store.getState().initialize();
  fail = true;
  assert.equal(await store.getState().select("baili"), false);
  assert.equal(store.getState().record.source, "custom");
  fail = false;
  await store.getState().select("none");
  assert.equal(store.getState().record.image, image);
  await store.getState().select("custom");
  assert.equal(store.getState().record.source, "custom");
});

test("非法图片、超限及不存在的自选图片不能保存", async () => {
  let writes = 0;
  const store = createWallpaperStore({
    read: async () => undefined,
    write: async () => {
      writes++;
    },
  });
  assert.equal(await store.getState().select("custom"), false);
  assert.equal(
    await store.getState().importImage(new Blob(["<svg/>"], { type: "image/svg+xml" })),
    false,
  );
  assert.equal(
    await store
      .getState()
      .importImage(new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: "image/png" })),
    false,
  );
  assert.equal(writes, 0);
});
