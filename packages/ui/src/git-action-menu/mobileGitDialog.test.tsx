import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DialogContent } from "../components/ui/dialog.js";

const source = await readFile(new URL("../GitActionMenu.tsx", import.meta.url), "utf8");
const pushDialog = source.slice(
  source.indexOf("function GitPushDialog("),
  source.indexOf("export function GitActionMenu("),
);
const commitDialog = source.slice(
  source.indexOf("function GitCommitDialog("),
  source.indexOf("interface GitPushDialogProps"),
);

// 源码/元素接线只证明具体 Dialog 的约束没有被通用 primitive 合并掉，不等于真实浏览器滚动通过。
function dialogContentClass(dialogSource: string): string {
  const className = dialogSource.match(/<DialogContent\b[\s\S]*?className="([^"]+)"/)?.[1];
  assert.ok(className);
  const portal = DialogContent({ className, children: null });
  return portal.props.children[1].props.className;
}

test("push dialog bounds width and height locally and scrolls all the way through its footer", () => {
  const className = dialogContentClass(pushDialog);
  assert.ok(className.includes("w-[calc(100%-2rem)]"));
  assert.match(className, /\bmax-w-lg\b/);
  assert.match(className, /max-h-\[85dvh\]/);
  assert.match(className, /\boverflow-y-auto\b/);
  assert.doesNotMatch(className, /\boverflow-(?:hidden|clip)\b/);
  assert.ok(pushDialog.indexOf("<DialogFooter") < pushDialog.indexOf("</DialogContent>"));
});

test("commit dialog retains the existing review scroll boundary with a narrow viewport margin", () => {
  const className = dialogContentClass(commitDialog);
  assert.match(className, /max-h-\[85dvh\]/);
  assert.match(className, /\boverflow-y-auto\b/);
  assert.match(className, /\bmax-w-md\b/);
  assert.ok(className.includes("w-[calc(100%-2rem)]"));
  assert.match(commitDialog, /<GitCommitReviewPanel/);
  assert.match(commitDialog, /!reviewCanSubmit/);
  assert.match(commitDialog, /!hasIdentity && state\?\.identity !== null/);
});

test("push details preserve long branches, full error text and the original action guards", () => {
  assert.match(pushDialog, /\[overflow-wrap:anywhere\]/);
  assert.match(pushDialog, /\bflex-wrap\b/);
  assert.match(pushDialog, /\{currentBranchLabel\}/);
  assert.match(pushDialog, /gitSummary\.trackingBranchName/);
  assert.match(pushDialog, /<Textarea[\s\S]*?readOnly[\s\S]*?>\s*\{error\}/);
  assert.match(pushDialog, /navigator\.clipboard\.writeText\(error\)/);
  assert.match(pushDialog, /onClick=\{onSubmit\}\s*disabled=\{mutationPending \|\| !pushEnabled\}/);
  assert.equal((pushDialog.match(/onClick=\{\(\) => onOpenChange\(false\)\}/g) ?? []).length, 2);
  assert.equal((pushDialog.match(/disabled=\{mutationPending\}/g) ?? []).length, 2);
  assert.match(pushDialog, /id: "common\.close"/);
  assert.match(pushDialog, /id: "common\.cancel"/);
});
