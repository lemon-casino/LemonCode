import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ToolCallRow,
  ToolCallSavedWorkflowListDisplay,
} from "@lcode/shared/lcode-protocol-v4";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { ListSavedWorkflowsToolCallBlock } from "./list-saved-workflows.js";

const entry = {
  name: "review",
  description: "Review the current changes",
  scope: "project",
  path: "/workspace/.lcode/workflows/review.dwf.ts",
  argNames: ["target"],
};

function render(options: {
  display?: ToolCallSavedWorkflowListDisplay;
  legacy?: unknown;
  locale?: "zh-CN" | "en-US";
  status?: ToolCallRow["status"];
  expanded?: boolean;
}) {
  const status = options.status ?? "success";
  const row: ToolCallRow = {
    kind: "toolCall",
    rowId: 1,
    turnId: "turn-saved-list",
    createdAt: 1,
    createdAtSeq: 1,
    toolCallId: `saved-list-${status}-${options.locale ?? "zh-CN"}`,
    toolName: "ListSavedWorkflows",
    inputText: "{}",
    status,
    output: {
      text: '<saved_workflows count="0"></saved_workflows>',
      ...(options.display ? { display: options.display } : {}),
    },
    ...(status === "error"
      ? { error: { code: "READ_FAILED", message: "Cannot read definitions" } }
      : {}),
  };
  const toolCallNode = toolCallRowToLegacyNode(row);
  if (options.legacy !== undefined) {
    toolCallNode.toolCall.raw = { result: options.legacy };
    toolCallNode.toolCall.output = options.legacy;
  }
  const context: ToolCallBlockRenderContext = {
    toolCallNode,
    workspacePath: "/workspace",
    viewerSource: null,
    rawFileSummaries: [],
    displayModel: {
      inlinePreview: { type: "none" },
      planResult: null,
      viewerSource: null,
      viewerLabelId: "codeViewer.viewCode",
      showSummaryFileLink: false,
      showInput: false,
      showOutput: false,
      showKind: false,
    },
    isRunning: status === "running",
    statusLabel: status === "error" ? "Failed" : "Done",
    errorText: status === "error" ? "Cannot read definitions" : undefined,
    childToolList: null,
    forceOpen: options.expanded ?? true,
  };
  return renderToStaticMarkup(
    <LCodeIntlProvider initialLocale={options.locale ?? "zh-CN"}>
      <ListSavedWorkflowsToolCallBlock {...context} />
    </LCodeIntlProvider>,
  );
}

test("真实空列表说明模板与运行历史不同，中英文标题不冒充保存成功", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const html = render({ display: { kind: "saved_workflow_list", workflows: [] }, locale });
    assert.match(html, locale === "zh-CN" ? /工作流模板/ : /Workflow templates/);
    assert.match(html, locale === "zh-CN" ? /项目和全局目录/ : /project or global archive/);
    assert.match(html, locale === "zh-CN" ? /运行记录/ : /run history/);
    assert.doesNotMatch(html, /这个项目里还没有保存过工作流|No saved workflows in this project/);
  }
});

test("canonical output.display 的有效列表不会被模型文本里的零条覆盖", () => {
  const html = render({ display: { kind: "saved_workflow_list", workflows: [entry] } });
  assert.match(html, /review/);
  assert.match(html, /target/);
  assert.match(html, /Review the current changes/);
  assert.doesNotMatch(html, /暂无可复用模板/);
});

test("只有无效文件时折叠摘要显示警告，展开后显示具体原因", () => {
  const display: ToolCallSavedWorkflowListDisplay = {
    kind: "saved_workflow_list",
    workflows: [],
    invalid: [{ path: "/workspace/.lcode/workflows/broken.dwf.ts", reason: "Missing description" }],
  };
  for (const expanded of [false, true]) {
    const html = render({ display, expanded });
    assert.match(html, /1 个模板文件无法读取/);
    assert.doesNotMatch(html, /暂无可复用模板|还没有保存过/);
    if (expanded) assert.match(html, /Missing description/);
  }
});

test("截断卡片的摘要与展开正文均说明仅展示部分结果", () => {
  for (const expanded of [false, true]) {
    const html = render({
      display: { kind: "saved_workflow_list", workflows: [entry], truncated: true },
      expanded,
    });
    assert.match(html, /已展示 1 个模板/);
    assert.match(html, /部分模板或说明未显示/);
  }
});

test("失败和仍在查询的零条载荷不显示成功空态", () => {
  for (const status of ["error", "running"] as const) {
    const html = render({ display: { kind: "saved_workflow_list", workflows: [] }, status });
    assert.doesNotMatch(html, /暂无可复用模板|还没有保存过/);
    assert.match(html, status === "error" ? /Cannot read definitions/ : /正在查询工作流模板/);
  }
});

test("legacy 非法条目不能静默变成空模板列表", () => {
  for (const legacy of [
    { workflows: [null] },
    { workflows: [{}] },
    { workflows: [{ name: " " }] },
    { workflows: [], invalid: [{}] },
  ]) {
    const html = render({ legacy });
    assert.doesNotMatch(html, /data-saved-workflow-list="true"|暂无可复用模板|还没有保存过/);
  }
});

test("旧 JSON 有效模板仍能显示参数，全局范围和无效文件共存", () => {
  const html = render({
    legacy: {
      workflows: [{ name: "global-review", scope: "global", args: { focus: { type: "string" } } }],
      invalid: [{ path: "broken.dwf.ts", reason: "Invalid header" }],
    },
  });
  assert.match(html, /global-review/);
  assert.match(html, /focus/);
  assert.match(html, /data-workflow-scope-tag="global"/);
  assert.match(html, /Invalid header/);
  assert.doesNotMatch(html, /暂无可复用模板/);
});
