import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { LCodeIntlProvider } from "../i18n/IntlProvider.js";
import { GitReviewStageNavigation } from "./GitReviewStageNavigation.js";
import { GitPublishOptionsPanel, type PublishOptionsPanelProps } from "./GitPublishOptionsPanel.js";
import { createPublishOptions } from "./publishModel.js";

const noop = () => {};
const render = (child: ReturnType<typeof createElement>, locale: "zh-CN" | "en-US" = "zh-CN") =>
  renderToStaticMarkup(
    createElement(LCodeIntlProvider, { initialLocale: locale, children: child }),
  );

test("完成合并后的来源视图直接显示真实目标的发布入口，结果可返回来源", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const source = render(
      createElement(GitReviewStageNavigation, {
        showMerge: false,
        publishedTarget: "L-GO",
        onBack: noop,
      }),
      locale,
    );
    assert.ok(
      source.includes(
        locale === "zh-CN" ? "查看合并结果并发布 L-GO" : "View merge result and publish L-GO",
      ),
    );
    const result = render(
      createElement(GitReviewStageNavigation, {
        showMerge: true,
        publishedTarget: "L-GO",
        onBack: noop,
      }),
      locale,
    );
    assert.ok(result.includes(locale === "zh-CN" ? "合并结果：L-GO" : "Merge result: L-GO"));
    assert.ok(result.includes(locale === "zh-CN" ? "返回工作树提交" : "Return to worktree commit"));
  }
});

const props: PublishOptionsPanelProps = {
  expanded: true,
  options: {
    ...createPublishOptions(),
    tagMode: "create",
    remotes: [{ name: "origin", branch: "任务".repeat(50) }],
  },
  branchName: "L-GO",
  remotes: [{ name: "origin", url: "https://example.invalid/repo.git" }],
  tags: [],
  unsupportedTags: [],
  loading: false,
  error: null,
  disabled: false,
  canCommit: false,
  remainingGroups: 0,
  presets: [],
  presetName: "",
  selectedPreset: "",
  onToggle: noop,
  onReload: noop,
  onChange: noop,
  onPreview: noop,
  onPresetNameChange: noop,
  onPresetSelect: noop,
  onPresetSave: noop,
  onPresetApply: noop,
  onPresetDelete: noop,
};

test("无待提交文件不阻止单独发布，提示原因并完整展示长远端分支", () => {
  const html = render(
    createElement(GitPublishOptionsPanel, {
      ...props,
      commitUnavailableHint: "当前所选范围没有待提交文件；可预览发布现有提交。",
    }),
  );
  assert.match(html, /data-testid="git-publish-commit-unavailable"/);
  assert.ok(html.includes("当前所选范围没有待提交文件"));
  assert.ok(html.includes("任务".repeat(50)));
  assert.match(html, /<details[^>]*data-testid="git-publish-presets"[^>]*>/);
  assert.doesNotMatch(html, /<details[^>]*\bopen=/);
  assert.match(html, /data-testid="git-publish-commit-preview"[^>]*disabled/);
  assert.doesNotMatch(html, /data-testid="git-publish-preview"[^>]*disabled/);
  assert.ok(html.includes("推送 Tag 可能触发远端的构建或发布流水线"));
});

test("合并目标发布具有分支名称且不要求再提交一次", () => {
  const html = render(
    createElement(GitPublishOptionsPanel, {
      ...props,
      allowCommitPreview: false,
      title: "发布 L-GO",
      previewLabel: "预览发布 L-GO",
    }),
  );
  assert.ok(html.includes("预览发布 L-GO"));
  assert.doesNotMatch(html, /data-testid="git-publish-commit-preview"/);
});
