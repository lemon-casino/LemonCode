// ============================================================
// 脚本文件在模型面的三句话
// ============================================================
//
// 工具响应是三个读者之一（另两个是终态通知与 `GetWorkflowRun`），而三个读者要把模型推向同一个
// 下一步：**去编辑那个文件**。所以这里只放一件事——知道脚本落在哪个文件之后，诊断行与 NOTE
// 该怎么写。`CreateWorkflow` 与 `AmendWorkflow` 共用它，因为「改完再 `path` 交回来」在两个工具
// 上是同一句话，分开写就会分叉成两句。
//
// 文件未知（草稿写不下去的项目）时这里一句都不出：调用方保留改动之前的老文案，模型读到的仍是
// 「改好脚本再提交一次」。

import type { CreateWorkflowDiagnostic } from "@zcode/contracts";

/**
 * 脚本文件在模型面的身份。`kind` 只影响一个动词：`draft` 是**工具刚写下**的拷贝（「saved at」），
 * `path` 是模型自己给的那个文件（「The script file is」）——对一个本来就存在的文件说「已保存到」，
 * 读起来像工具刚动过它。
 */
export interface WorkflowScriptLocation {
  kind: "draft" | "path";
  /** 模型面的写法（工作区相对或绝对），由 `describeWorkflowScriptPath` 算出。 */
  described: string;
  /** 正文行 → 文件行的偏移；无元数据块即 0。 */
  lineOffset: number;
}

/**
 * 诊断的模型面行。有文件就写成 `{path}:L{line}:C{column} {message}`，行号按**文件**数——
 * 这个数要能直接粘进一次对该文件的 `Edit`。没有文件时退回老的 `L:C` 形式（正文行）。
 *
 * 输出里的 `diagnostics` 数组与 display 载荷**不**跟着改：转录面画的是正文，正文行才是它的坐标。
 */
export function formatWorkflowDiagnosticLines(
  diagnostics: readonly CreateWorkflowDiagnostic[],
  location: WorkflowScriptLocation | undefined,
): string[] {
  if (location === undefined) {
    return diagnostics.map(
      (diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`,
    );
  }
  return diagnostics.map(
    (diagnostic) =>
      `${location.described}:L${diagnostic.line + location.lineOffset}:C${diagnostic.column} ${diagnostic.message}`,
  );
}

/**
 * 编不过、且脚本有文件时的 NOTE（内联与 `path` 两条来源）。最后半句是这整个特性的目的：
 * **别再把脚本贴一遍**。
 */
export function workflowScriptFileNote(location: WorkflowScriptLocation): string {
  const where =
    location.kind === "draft"
      ? `The script is saved at ${location.described}.`
      : `The script file is ${location.described}.`;
  return `NOTE: The workflow was NOT executed. ${where} Edit that file in place and resubmit with \`path: "${location.described}"\` — do not paste the script inline again.`;
}

/**
 * 编不过、来源是 saved 定义时的 NOTE。多说两件事：这份拷贝是**从哪个定义抄来的**（模型据此知道
 * 改的是拷贝不是定义），以及改定义本身要走 `SaveWorkflow`。实参要再传一次——拷贝带着元数据块，
 * 声明还在，所以 `path` 提交同样会校验它们。
 */
export function workflowSavedDraftNote(options: {
  savedName: string;
  savedPath: string;
  draft: string;
}): string {
  return `NOTE: The workflow was NOT executed. A working copy of the saved workflow '${options.savedName}' (${options.savedPath}) was written to ${options.draft}. Edit that copy in place and resubmit with \`path: "${options.draft}"\` (pass its \`args\` again); to change the saved definition itself, use SaveWorkflow.`;
}

/** 启动成功后追加的一句：下一次修订从编辑这个文件开始。 */
export function workflowLaunchedScriptSentence(location: WorkflowScriptLocation): string {
  const where =
    location.kind === "draft"
      ? `The script is saved at ${location.described}`
      : `The script file is ${location.described}`;
  return ` ${where}; to revise it later, use compact \`edits\` when the exact old fragment is known, otherwise edit that file and pass \`path\` to AmendWorkflow.`;
}

/** 修订启动成功后追加的一句（再修订一次仍是同一个动作）。 */
export function workflowAmendedScriptSentence(location: WorkflowScriptLocation): string {
  return ` The revision's script is at ${location.described}; use compact \`edits\` for a known exact fragment, or edit that file and pass \`path\` for a further revision.`;
}
