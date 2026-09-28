// ============================================================
// 工作流脚本文件的模型面写法
// ============================================================
// journal 里存的永远是**绝对路径**：它是 run 身份的一部分，而会话的工作目录会变（`cd`、
// 另一个会话读同一个 run），相对路径存下来就会在别处指向别的文件。
//
// 但模型看到的应该是工作区里的写法：它接下来要做的事是 `Edit` 这个文件，而工作区相对路径
// 正是它在别处读写文件时用的那一种。两者只差这一个纯函数——铸一次、三个模型面共用
// （终态通知、`GetWorkflowRun`、工具响应），所以不可能在三处之间分叉。

import path from "node:path";

/**
 * 把脚本文件的绝对路径写成模型面该看到的样子：在会话工作目录之下就给工作区相对路径，
 * 否则原样给绝对路径。
 *
 * 「在工作目录之下」的判据是 `path.relative` 的结果既不以 `..` 开头、也不是绝对路径——
 * 这一条同时挡住了两种不能相对化的情形：目录外的兄弟路径（`../other/x.dwf.ts`，相对写法
 * 读起来像在说工作区里有这么个东西），以及 Windows 上的跨盘符（`C:` → `D:`，`path.relative`
 * 直接给回绝对路径）。空结果（路径恰好等于工作目录）同样退回绝对路径：空串不是一个能
 * `Edit` 的文件名。
 *
 * `cwd` 缺席即宿主没有工作目录概念（部分端口 stub / 无会话上下文），此时无从相对化。
 */
export function describeWorkflowScriptPath(absolutePath: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === "") return absolutePath;
  const relative = path.relative(cwd, absolutePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return absolutePath;
  }
  return relative;
}
