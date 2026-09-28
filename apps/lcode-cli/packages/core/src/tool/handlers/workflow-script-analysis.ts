// ============================================================
// Workflow script analysis - 单槽记忆的共享入口
// ============================================================
//
// 审批 gate 会在执行前分析脚本，handler 执行后又分析一次，一次获批调用因此要跑两遍
// TypeScript 程序。按脚本原文做单槽记忆把这一对折叠成一次编译；刻意不是通用缓存——
// 唯一值得收敛的重复就是这组紧邻的前后调用。
//
// 抽到本模块是因为**两个**工具现在共用它：CreateWorkflow 跑脚本前要编译，SaveWorkflow
// 存脚本前也要编译，而且必须是同一个检查器——「能存下来但跑不起来」是这个特性最难解释的
// 一种坏掉方式。

import { analyzeWorkflowScript, type AnalyzeResult } from "@lcode/dynamic-workflow";

let lastAnalysis: { script: string; result: AnalyzeResult } | null = null;

/** 编译并分析一段 workflow 脚本，紧邻的重复调用命中记忆槽。 */
export function analyzeScript(script: string): AnalyzeResult {
  if (lastAnalysis?.script === script) return lastAnalysis.result;
  const result = analyzeWorkflowScript(script);
  lastAnalysis = { script, result };
  return result;
}
