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
  assert.match(
    source,
    /const canRenderGit = Boolean\(\s*gitSummary\?\.isGitAvailable && gitSummary\.isRepository && canMountGit,?\s*\)/u,
  );
  assert.doesNotMatch(source, /<div className=\{cn\(!model\.git && "hidden"\)\}>/u);
  assert.match(
    source,
    /!model\.hasContent && !canRenderEndedWorkflows && !canRenderGit && "hidden"/u,
  );
  assert.match(source, /if \(!model\.hasContent && !canRenderEndedWorkflows && !canMountGit\) \{/u);
});

test("干净仓库 mini 胶囊仍有可展开的发布入口", () => {
  const summary = source.slice(
    source.indexOf("function StatusSummaryRow("),
    source.indexOf("function ConversationStatusPanelImpl("),
  );
  assert.equal(summary.includes("canRenderGit ? ("), true);
  // 标题跟随实际执行绑定，文案由浏览器回归验证；这里仅约束入口仍然挂载。
  assert.equal(source.includes("canRenderGit={canRenderGit}"), true);
});

test("workflow 次级摘要复用父投影与已有详情、停止入口", async () => {
  const section = source.slice(
    source.indexOf("function WorkflowStatusSection("),
    source.indexOf("function SubagentStatusSection("),
  );
  assert.match(
    section,
    /workflowActivitySummaryText\(run\.activitySummary, intl\.formatMessage\)/u,
  );
  assert.match(section, /data-testid="workflow-status-activity"/u);
  assert.match(section, /data-workflow-run-details-trigger="true"/u);
  assert.match(section, /<RunningWorkCancelButton/u);
  assert.doesNotMatch(section, /useConversationProjection|useChildSession|workflow-activity-open/u);
  const session = await readFile(new URL("./SessionPane.tsx", import.meta.url), "utf8");
  const props = session.slice(session.indexOf("<ConversationStatusPanel"));
  assert.match(props, /workflowDisplay=\{workflowDisplay\}/u);
  assert.match(
    session,
    /workflowProjectionDisplay\(\{ status: state\.status, syncing: state\.syncing \}\)/u,
  );
});
