import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function readSource(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

test("workspace help menu no longer offers issue report or feature request", async () => {
  const source = await readSource("./WorkspaceHelpMenuButton.tsx");
  for (const id of [
    "workspaceHeader.help.issueReport",
    "workspaceHeader.help.productRequest",
    "workspaceHeader.help.productRequestDraft",
  ]) {
    assert.equal(source.includes(id), false, id);
  }
  // 入口删除不能顺手删掉仍然保留的两项。
  assert.match(source, /workspaceHeader\.help\.docs/);
  assert.match(source, /workspaceHeader\.help\.community/);
});

test("help menu action handlers keep only product docs and export logs", async () => {
  const source = await readSource("./lib/helpMenuActions.ts");
  assert.equal(source.includes("openIssueReport"), false);
  assert.equal(source.includes("FeedbackSubmitDraft"), false);
  assert.match(source, /openProductDocs/);
  assert.match(source, /exportLogs/);
});

test("feature request dialog and its store state are gone, feedback center keeps submit path", async () => {
  const store = await readSource("./feedback/feedbackStore.ts");
  for (const token of ["featureRequestOpen", "openFeatureRequest"]) {
    assert.equal(store.includes(token), false, token);
  }
  // 问题上报能力保留：删除的只是帮助菜单入口，提交表单入口仍在。
  assert.match(store, /openSubmit/);
  assert.match(store, /openTickets/);

  const center = await readSource("./feedback/FeedbackCenter.tsx");
  assert.equal(center.includes("FeatureRequestDialog"), false);
  assert.match(center, /FeedbackSubmitForm/);
});

test("native desktop help menu drops the feedback item but keeps export logs and resource manager", async () => {
  const source = await readSource("../../desktop/src/main/desktopApplicationMenu.ts");
  assert.equal(source.includes("helpFeedback"), false);
  assert.match(source, /desktopMenuMessageIds\.helpExportLogs/);
  assert.match(source, /desktopMenuMessageIds\.helpResourceManager/);
});
