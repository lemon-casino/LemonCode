// ============================================================
// Workflow analysis → display - 静态分析结果到显示图 / 结果卡的唯一投影
// ============================================================
//
// 显示图由**三份**分析投影拼成：因果图给站点与车道，控制流图给阶段词汇表与阶段边，交接图给
// 每阶段的子代理卡与交接边。少传任何一份，图就静默地缺一层——中枢直接启动
// 的 run 详情侧板没有时间线、没有子代理，根因正是启动路径只传了因果图。所以「分析结果 →
// 有界显示图」只在这里拼一次；CreateWorkflow 的 handler、确认窗 gate 与直接启动三处调用它，
// 谁都不再在调用点手拼 `boundCausalityGraph(...)` 的实参。

import {
  CREATE_WORKFLOW_TOOL_NAME,
  type CreateWorkflowCausalityGraph,
  type CreateWorkflowOutput,
  type ToolResultDisplayPayload,
} from "@lcode/contracts";
import type { AnalyzeResult } from "@lcode/dynamic-workflow";
import { createCreateWorkflowDisplay } from "../executor/result-display.js";
import { boundCausalityGraph } from "./create-workflow-graph-bounds.js";

/** 分析结果的有界显示图；脚本连一个站点都分析不出（编译失败早于因果图）时缺席。 */
export function boundGraphOfAnalysis(
  analysis: AnalyzeResult,
): CreateWorkflowCausalityGraph | undefined {
  return analysis.causality === undefined
    ? undefined
    : boundCausalityGraph(analysis.causality, analysis.flow, analysis.handoff);
}

/**
 * 分析结果的 `create_workflow` display（确认窗、启动轮元数据）。面向模型的 `response` 在这些
 * 读者面前没有内容——display 投影本身也不读它。AmendWorkflow 传自己的工具名：两个启动工具
 * 共用同一个 display kind。
 */
export function displayOfAnalysis(
  analysis: AnalyzeResult,
  toolName: string = CREATE_WORKFLOW_TOOL_NAME,
): ToolResultDisplayPayload | undefined {
  const causalityGraph = boundGraphOfAnalysis(analysis);
  return createCreateWorkflowDisplay(toolName, {
    diagnostics: analysis.diagnostics,
    ok: analysis.ok,
    response: "",
    ...(causalityGraph === undefined ? {} : { causalityGraph }),
  } satisfies CreateWorkflowOutput);
}
