// 品牌 ZCode → LCode 数据迁移测试（specs/brand-migration-lcode.md 批次 2 验收清单的自动化部分）
// 运行：npx tsx --test scripts/lcode-brand-migration.test.mjs
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  migrateDirCopyStyleSync,
  migrateHomeBrandDataRootSync,
  migrateWorkspaceBrandDirsSync,
} from "../packages/shared/src/node/brandDataMigration.ts";

test("home 数据根迁移：旧目录整体复制、凭据/设置旧键别名补写、源目录保留", async () => {
  const home = await mkdtemp(join(tmpdir(), "lcode-migr-home-"));
  try {
    const legacy = join(home, ".zcode");
    await mkdir(join(legacy, "v2"), { recursive: true });
    await mkdir(join(legacy, "cli", "db"), { recursive: true });
    await writeFile(
      join(legacy, "v2", "credentials.json"),
      JSON.stringify({ zcodejwttoken: "jwt-old", "oauth:active_provider": "glm" }),
    );
    await writeFile(
      join(legacy, "v2", "setting.json"),
      JSON.stringify({ zcodeEndpointOrigin: "https://example.test", theme: "zai-dark" }),
    );
    await writeFile(join(legacy, "cli", "db", "db.sqlite"), "sqlite-bytes");

    const outcome = migrateHomeBrandDataRootSync(home);
    assert.equal(outcome.status, "migrated", JSON.stringify(outcome));

    // 新目录可读且值不丢
    const credentials = JSON.parse(await readFile(join(home, ".lcode", "v2", "credentials.json"), "utf8"));
    assert.equal(credentials.lcodejwttoken, "jwt-old");
    assert.equal(credentials["oauth:active_provider"], "glm");
    const settings = JSON.parse(await readFile(join(home, ".lcode", "v2", "setting.json"), "utf8"));
    assert.equal(settings.lcodeEndpointOrigin, "https://example.test");
    assert.equal(settings.theme, "zai-dark");
    assert.equal(await readFile(join(home, ".lcode", "cli", "db", "db.sqlite"), "utf8"), "sqlite-bytes");

    // 源目录保留（复制式迁移、回滚无损）
    assert.ok(existsSync(join(legacy, "v2", "credentials.json")));
    assert.ok(existsSync(join(legacy, "cli", "db", "db.sqlite")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("home 数据根迁移幂等：二次调用 skipped 且不改动目标", async () => {
  const home = await mkdtemp(join(tmpdir(), "lcode-migr-idem-"));
  try {
    await mkdir(join(home, ".zcode", "v2"), { recursive: true });
    await writeFile(join(home, ".zcode", "v2", "setting.json"), JSON.stringify({ a: 1 }));
    assert.equal(migrateHomeBrandDataRootSync(home).status, "migrated");
    const target = join(home, ".lcode", "v2", "setting.json");
    const before = await readFile(target, "utf8");
    const second = migrateHomeBrandDataRootSync(home);
    assert.equal(second.status, "skipped");
    assert.equal(await readFile(target, "utf8"), before);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("迁移失败注入：目标父目录不存在时走失败分支，源目录完好", async () => {
  const home = await mkdtemp(join(tmpdir(), "lcode-migr-fail-"));
  try {
    await mkdir(join(home, ".zcode", "v2"), { recursive: true });
    await writeFile(join(home, ".zcode", "v2", "setting.json"), JSON.stringify({ a: 1 }));
    // 目标路径中一段是"文件"：ENOTDIR，走失败分支（跨平台稳定注入；node cp 会递归建父目录，不能用缺失父目录注入）
    await writeFile(join(home, "occupied"), "blocker");
    const outcome = migrateDirCopyStyleSync(join(home, ".zcode"), join(home, "occupied", ".lcode"));
    assert.equal(outcome.status, "failed");
    assert.ok(outcome.error && outcome.error.length > 0, JSON.stringify(outcome));
    // 源目录完好
    assert.equal(
      await readFile(join(home, ".zcode", "v2", "setting.json"), "utf8"),
      JSON.stringify({ a: 1 }),
    );
    // 无临时目录残留
    const leftovers = readdirSync(home).filter((e) => e.includes(".migrating-"));
    assert.deepEqual(leftovers, [], JSON.stringify(leftovers));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("无旧目录时 missing 快速返回，不创建新目录", () => {
  const home = mkdtempSync(join(tmpdir(), "lcode-migr-none-"));
  try {
    const outcome = migrateHomeBrandDataRootSync(home);
    assert.equal(outcome.status, "missing");
    assert.ok(!existsSync(join(home, ".lcode")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("工作区迁移：.zcode/.zcode-plugin → .lcode/.lcode-plugin，源保留、幂等", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lcode-migr-ws-"));
  try {
    await mkdir(join(workspace, ".zcode", "skills"), { recursive: true });
    await mkdir(join(workspace, ".zcode-plugin", "demo"), { recursive: true });
    await writeFile(join(workspace, ".zcode", "skills", "demo.md"), "skill");
    await writeFile(join(workspace, ".zcode-plugin", "demo", "plugin.json"), "{}");

    const summary = migrateWorkspaceBrandDirsSync(workspace);
    assert.deepEqual(
      summary.outcomes.map((o) => o.status),
      ["migrated", "migrated"],
      JSON.stringify(summary),
    );
    assert.equal(await readFile(join(workspace, ".lcode", "skills", "demo.md"), "utf8"), "skill");
    assert.ok(existsSync(join(workspace, ".lcode-plugin", "demo", "plugin.json")));
    assert.ok(existsSync(join(workspace, ".zcode", "skills", "demo.md")));

    const second = migrateWorkspaceBrandDirsSync(workspace);
    assert.deepEqual(
      second.outcomes.map((o) => o.status),
      ["skipped", "skipped"],
      JSON.stringify(second),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("migrateDirCopyStyleSync 对符号链接按链接复制而非实体复制", async () => {
  const base = await mkdtemp(join(tmpdir(), "lcode-migr-link-"));
  try {
    mkdirSync(join(base, "src", "inner"), { recursive: true });
    writeFileSync(join(base, "src", "inner", "file.txt"), "data");
    symlinkSync(join(base, "src", "inner"), join(base, "src", "link"), "dir");
    const outcome = migrateDirCopyStyleSync(join(base, "src"), join(base, "dst"));
    assert.equal(outcome.status, "migrated", JSON.stringify(outcome));
    assert.ok(lstatSync(join(base, "dst", "link")).isSymbolicLink(), "符号链接应按链接本身复制");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
