import assert from "node:assert/strict";
import test from "node:test";
import { STORAGE_CATEGORY_IDS } from "@lcode/shared";
import { planStorageClean, type StorageCleanCandidate } from "./domain/cleanPlan.js";
import {
  classifyStoragePath,
  getStorageCategoryCleanability,
  getStorageCleanScopes,
} from "./domain/storageCatalog.js";
import { createStorageUsageAccumulator } from "./domain/usageAggregate.js";

const context = { rootId: "home" as const, hasCustomDataBaseDir: false };
const now = new Date(2026, 9, 15, 12).getTime();
const day = 24 * 60 * 60 * 1000;
const candidate = (relativePath: string, ageDays = 10): StorageCleanCandidate => ({
  relativePath,
  bytes: 100,
  mtimeMs: now - ageDays * day,
});

test("known Git, runtime, media, temporary and legacy data have specific categories", () => {
  const cases = [
    ["v2/worktrees/bindings/task.json", "worktreeData"],
    ["v2/git-review-workspaces/task/state.json", "worktreeData"],
    ["git-checkpoint-index/task/index", "worktreeData"],
    ["v2/git-backup/repositories/repo.bundle", "gitBackups"],
    ["v2/runtime-environments/tools/node/node.exe", "runtimes"],
    ["v2/runtime-environments/package-store/pnpm/v10/files/hash", "pnpmCache"],
    ["v2/runtime-environments/package-store/other/file", "runtimes"],
    ["v2/runtime/provider/provisioning.json", "config"],
    ["cli/video-cache/session/video.mp4", "mediaCache"],
    ["cli/image-cache/session/image.png", "mediaCache"],
    ["cli/pdf-cache/session/file.pdf", "mediaCache"],
    ["editor-icon/icon-123/icon.png", "editorCache"],
    ["tmp/paste-attachments/date/file.txt", "temporaryFiles"],
    ["clipboard/image.png", "temporaryFiles"],
    ["cache/unknown/file", "temporaryFiles"],
    ["agent/old/node.exe", "legacyData"],
    ["cli/artifacts/session/source.json", "toolOutputs"],
    ["cli/plugins/cache/plugin.js", "runtimes"],
    ["v2/unknown/data.bin", "other"],
  ];
  for (const [path, expected] of cases) {
    assert.equal(classifyStoragePath(path!, context).categoryId, expected, path);
    assert.equal(classifyStoragePath(path!.replaceAll("/", "\\"), context).categoryId, expected);
  }
  for (const id of STORAGE_CATEGORY_IDS) assert.ok(getStorageCategoryCleanability(id));
});

test("pnpm cache requires its package manager port and cannot use generic file deletion", () => {
  assert.equal(getStorageCategoryCleanability("pnpmCache"), "safe");
  assert.deepEqual(getStorageCleanScopes("pnpmCache"), []);
  assert.deepEqual(
    planStorageClean({
      categoryId: "pnpmCache",
      candidates: [candidate("v2/runtime-environments/package-store/pnpm/v10/files/hash")],
      context,
      now,
    }).targets,
    [],
  );
  assert.equal(
    classifyStoragePath("v2/runtime-environments/package-store/pnpm/v10/files/hash", {
      rootId: "home",
      hasCustomDataBaseDir: true,
    }).categoryId,
    "legacyData",
  );
});

test("custom storage keeps all home v2 data protected and splits its details", () => {
  const migrated = { rootId: "home" as const, hasCustomDataBaseDir: true };
  for (const path of ["v2/logs/old.log", "v2/worktrees/id.json", "v2/setting.json"]) {
    const result = classifyStoragePath(path, migrated);
    assert.equal(result.categoryId, "legacyData");
    assert.equal(result.entryKey, path.split("/").slice(0, 2).join("/"));
    const plan = planStorageClean({
      categoryId: "logs",
      candidates: [candidate(path)],
      context: migrated,
      now,
    });
    assert.deepEqual(plan.targets, []);
  }
  assert.equal(
    classifyStoragePath("v2/logs/a.log", { ...migrated, rootId: "dataBaseDir" }).categoryId,
    "logs",
  );
});

test("unknown details are split by two levels and totals remain exact", () => {
  const accumulator = createStorageUsageAccumulator({ ...context, id: "home", path: "/fixture" });
  for (const path of [
    "v2/unknown-a/one",
    "v2/unknown-b/two",
    "v2/unknown-a/three",
    "cli/video-cache/s/video.mp4",
  ]) {
    accumulator.add(candidate(path));
  }
  const snapshot = accumulator.snapshot(null);
  assert.equal(snapshot.bytes, 400);
  assert.equal(
    snapshot.categories.reduce((sum, item) => sum + item.bytes, 0),
    400,
  );
  assert.deepEqual(snapshot.categories.find((item) => item.id === "other")?.entries, [
    { relativePath: "v2/unknown-a", bytes: 200, fileCount: 2 },
    { relativePath: "v2/unknown-b", bytes: 100, fileCount: 1 },
  ]);
});

test("media cleaning retains all formats in sessions with recent source or cache activity", () => {
  const files = [
    candidate("cli/image-cache/idle/image.png"),
    candidate("cli/pdf-cache/idle/pdf.pdf"),
    candidate("cli/video-cache/recent/video.mp4"),
    candidate("cli/artifacts/recent/source.json", 1),
    candidate("cli/image-cache/mixed/image.png"),
    candidate("cli/pdf-cache/mixed/pdf.pdf", 2),
    candidate("cli/video-cache/boundary/video.mp4", 7),
    candidate("cli/video-cache/future/video.mp4", -1),
    candidate("cli/image-cache/protected/credentials.json"),
    candidate("cli/artifacts/idle/source.json"),
    candidate("tmp/paste-attachments/old.txt"),
  ];
  const plan = planStorageClean({ categoryId: "mediaCache", candidates: files, context, now });
  assert.deepEqual(
    plan.targets.map((item) => item.relativePath),
    files.slice(0, 2).map((item) => item.relativePath),
  );
  assert.equal(plan.skippedCount, files.length - 2);
  const windows = files.map((file) => ({
    ...file,
    relativePath: file.relativePath.replaceAll("/", "\\"),
  }));
  assert.equal(
    planStorageClean({ categoryId: "mediaCache", candidates: windows, context, now }).targets
      .length,
    2,
  );
});

test("only old editor icons are cleanable; unique attachments and business data are retained", () => {
  const files = [
    candidate("editor-icon/old/icon.png", 2),
    candidate("editor-icon/boundary/icon.png", 1),
    candidate("editor-icon/live/icon.png", 0),
  ];
  assert.deepEqual(
    planStorageClean({ categoryId: "editorCache", candidates: files, context, now }).targets,
    [files[0]],
  );
  for (const categoryId of [
    "temporaryFiles",
    "legacyData",
    "worktreeData",
    "gitBackups",
    "runtimes",
    "config",
    "toolOutputs",
    "other",
  ] as const) {
    assert.equal(getStorageCategoryCleanability(categoryId), "none");
    assert.deepEqual(planStorageClean({ categoryId, candidates: files, context, now }).targets, []);
  }
});

test("existing log and subagent protections still apply", () => {
  const logs = [
    candidate("v2/logs/old.log"),
    candidate("v2/logs/today.log", 0),
    candidate("v2/crash/live/report.json"),
    candidate("v2/logs/credentials.json"),
  ];
  assert.deepEqual(
    planStorageClean({ categoryId: "logs", candidates: logs, context, now }).targets,
    [logs[0]],
  );
  const agents = [
    candidate("cli/agents/idle/agent/transcript.jsonl"),
    candidate("cli/agents/active/agent/transcript.jsonl"),
    candidate("cli/agents/active/agent/metadata.json", 0),
  ];
  assert.deepEqual(
    planStorageClean({ categoryId: "subagentTranscripts", candidates: agents, context, now })
      .targets,
    [agents[0]],
  );
});
