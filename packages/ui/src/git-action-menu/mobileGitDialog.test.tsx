import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DialogContent } from "../components/ui/dialog.js";

const commitDialog = await readFile(new URL("./GitCommitDialog.tsx", import.meta.url), "utf8");
const feedback = await readFile(new URL("./GitPublishFeedback.tsx", import.meta.url), "utf8");
const reviewPanel = await readFile(new URL("./GitCommitReviewPanel.tsx", import.meta.url), "utf8");
const controller = await readFile(new URL("../GitActionMenu.tsx", import.meta.url), "utf8");

// 接线测试只证明使用同一有界 Dialog primitive；真实视口/滚动由 Web 夹具验证。
function dialogContentClass(dialogSource: string): string {
  const className = dialogSource.match(/<DialogContent\b[\s\S]*?className="([^"]+)"/)?.[1];
  assert.ok(className);
  const portal = DialogContent({ className, children: null });
  return portal.props.children[1].props.className;
}

test("commit and publish share the same bounded scrollable dialog on mobile", () => {
  const className = dialogContentClass(commitDialog);
  assert.ok(className.includes("w-[calc(100%-2rem)]"));
  assert.match(className, /\bmax-w-md\b/);
  assert.match(className, /max-h-\[85dvh\]/);
  assert.match(className, /\boverflow-y-auto\b/);
  assert.match(commitDialog, /<GitCommitReviewPanel/);
  assert.match(commitDialog, /<GitPublishPreview/);
  assert.match(commitDialog, /<GitPublishResults/);
  assert.doesNotMatch(controller, /GitPushDialog|openPushDialog/);
});

test("publication preserves readable full errors and retries only failed pushes", () => {
  assert.match(feedback, /\[overflow-wrap:anywhere\]/);
  assert.match(feedback, /\bflex-wrap\b/);
  assert.match(feedback, /row\.message/);
  assert.match(feedback, /row\.status === "failed"/);
  assert.match(feedback, /row\.kind === "branch" \|\| row\.kind === "tag"/);
  assert.match(controller, /platform\.writeClipboardText/);
  assert.doesNotMatch(controller, /navigator\.clipboard/);
});

test("keyboard action cannot select publishing or bypass regeneration/review guards", () => {
  assert.match(commitDialog, /!reviewCanSubmit/);
  assert.match(commitDialog, /props\.requiresRegeneration/);
  assert.match(commitDialog, /!hasIdentity && state\?\.identity !== null/);
  assert.match(commitDialog, /matchesPrimaryShortcut\(event, "Enter"\)/);
  assert.match(commitDialog, /if \(!commitActionDisabled\) props\.onSubmit\(\)/);
  assert.doesNotMatch(commitDialog, /triggerSelectedAction/);
});

test("large frozen reviews keep confirmation and manual fallback before a bounded file list", () => {
  const acknowledge = reviewPanel.indexOf('data-testid="git-review-acknowledge"');
  const manualFallback = reviewPanel.indexOf('data-testid="git-review-manual-fallback"');
  const files = reviewPanel.indexOf('data-testid="git-review-files"');
  assert.ok(acknowledge >= 0 && acknowledge < files);
  assert.ok(manualFallback >= 0 && manualFallback < files);
  assert.match(reviewPanel, /max-h-72 space-y-2 overflow-y-auto overscroll-contain/);
});
