import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ConversationStatusPanel.tsx", import.meta.url), "utf8");

test("mini 和环境区块收起时仍挂载自动提交弹窗控制器", () => {
  // 交互回归约束：GitActionMenu 持有自动打开 useEffect；隐藏入口不能卸载组件。
  assert.equal(
    /<CollapsibleContent forceMount=\{section === "environment" \? true : undefined\}>/u.test(
      source,
    ),
    true,
  );
  const contentStart = source.indexOf("{/* 修复依据：GitActionMenu 持有自动草稿消费");
  assert.notEqual(contentStart, -1);
  const panelContent = source.slice(
    contentStart,
    source.indexOf("<GitStatusSection", contentStart),
  );
  assert.equal(/variant !== "mini"\s*\?/u.test(panelContent), false);
  assert.equal(/variant === "mini"\s*\?\s*"hidden"/u.test(panelContent), true);
});

test("无行级统计时也挂载 Git 自动弹窗控制器", () => {
  // 交互回归约束：空文件或二进制文件可能是脏文件，但 added/removed 都是零。
  assert.match(source, /const canMountGit = Boolean\(gitSummary && onRefreshGit\)/u);
  assert.match(source, /\{canMountGit \? \(\s*<GitStatusSection/u);
  assert.match(source, /<div className=\{cn\(!model\.git && "hidden"\)\}>/u);
  assert.match(source, /if \(!model\.hasContent && !canRenderEndedWorkflows && !canMountGit\) \{/u);
});
