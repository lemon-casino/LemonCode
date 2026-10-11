import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSettingService } from "./settingService.js";

test("memory storage location persists through the original settings owner and unrelated patches", async (t) => {
  t.mock.method(console, "log", () => {});
  const directory = await mkdtemp(join(tmpdir(), "lcode-memory-settings-"));
  const previous = process.env.LCODE_DESKTOP_HOME_DIR;
  process.env.LCODE_DESKTOP_HOME_DIR = directory;
  try {
    const first = createSettingService();
    assert.equal((await first.get()).memoryStorageLocation, "profile");
    assert.equal((await first.get()).memoryStorageRevision, 0);
    await first.update({
      memoryStorageLocation: "workspace",
      memoryStorageRevision: 1,
      memoryEnabled: false,
    });
    await createSettingService().update({ sessionRecallEnabled: true });
    const persisted = JSON.parse(
      await readFile(join(directory, ".lcode", "v2", "setting.json"), "utf8"),
    );
    assert.equal(persisted.memoryStorageLocation, "workspace");
    assert.equal(persisted.memoryStorageRevision, 1);
    assert.equal((await createSettingService().get()).memoryStorageLocation, "workspace");
    assert.equal((await createSettingService().get()).memoryStorageRevision, 1);
    await assert.rejects(first.update({ memoryStorageLocation: "other" } as never));
    assert.equal((await first.get()).memoryStorageLocation, "workspace");
    await assert.rejects(first.update({ memoryStorageRevision: Number.MAX_SAFE_INTEGER + 1 }));
    assert.equal((await first.get()).memoryStorageRevision, 1);
    await first.update({ memoryStorageLocation: "profile", memoryStorageRevision: 2 });
    assert.equal((await createSettingService().get()).memoryStorageLocation, "profile");
    assert.equal((await first.get()).sessionRecallEnabled, true);
    assert.equal((await createSettingService().get()).memoryStorageRevision, 2);
  } finally {
    if (previous === undefined) delete process.env.LCODE_DESKTOP_HOME_DIR;
    else process.env.LCODE_DESKTOP_HOME_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("the persisted settings owner rejects unpaired memory location and revision mutations", async (t) => {
  t.mock.method(console, "log", () => {});
  const directory = await mkdtemp(join(tmpdir(), "lcode-memory-owner-"));
  const previous = process.env.LCODE_DESKTOP_HOME_DIR;
  process.env.LCODE_DESKTOP_HOME_DIR = directory;
  try {
    const first = createSettingService();
    const second = createSettingService();
    await first.update({ memoryEnabled: false });
    const path = join(directory, ".lcode", "v2", "setting.json");
    const before = await readFile(path, "utf8");
    for (const patch of [
      { memoryStorageLocation: "workspace" as const },
      { memoryStorageRevision: 1 },
      { memoryStorageLocation: "workspace" as const, memoryStorageRevision: 0 },
      { memoryStorageLocation: "workspace" as const, memoryStorageRevision: 2 },
    ]) {
      await assert.rejects(first.update(patch), /memory storage.*revision/i);
      assert.equal(
        await readFile(path, "utf8"),
        before,
        "a rejected mutation cannot rewrite settings",
      );
    }
    await first.update({ memoryStorageLocation: "workspace", memoryStorageRevision: 1 });
    const committed = await readFile(path, "utf8");
    for (const patch of [
      { memoryStorageRevision: 0 },
      { memoryStorageRevision: 2 },
      { memoryStorageLocation: "profile" as const },
      { memoryStorageLocation: "profile" as const, memoryStorageRevision: 1 },
      { memoryStorageLocation: "profile" as const, memoryStorageRevision: 3 },
    ]) {
      await assert.rejects(second.update(patch), /memory storage.*revision/i);
      assert.equal(await readFile(path, "utf8"), committed);
    }
    await second.update({ memoryStorageLocation: "workspace", memoryStorageRevision: 1 });
    await first.update({ memoryStorageLocation: "workspace" });
    await second.update({ sessionRecallEnabled: true });
    assert.equal((await first.get()).memoryStorageRevision, 1);
    await second.update({ memoryStorageLocation: "profile", memoryStorageRevision: 2 });
    assert.equal((await first.get()).memoryStorageLocation, "profile");
    assert.equal((await first.get()).memoryStorageRevision, 2);
    assert.equal((await first.get()).sessionRecallEnabled, true);
  } finally {
    if (previous === undefined) delete process.env.LCODE_DESKTOP_HOME_DIR;
    else process.env.LCODE_DESKTOP_HOME_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
