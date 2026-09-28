import {
  expandCustomCommandPrompt,
  expandCustomCommandTemplate,
  formatCustomCommandPrompt,
  type ExecutionPort,
  type SessionId,
  type TraceContext,
} from "@lcode/contracts";
import { loadLCodeCustomCommand, type ListLCodeCustomCommandsOptions } from "./custom-commands.js";
import { expandCustomCommandShellSyntax } from "./custom-command-shell-expansion.js";
import { isReservedLCodeSlashCommandName } from "./slash-command-surface.js";

const CUSTOM_COMMAND_NOT_FOUND_PATTERN = /not found/i;
const PROMPT_CUSTOM_COMMAND_PATTERN = /^\/([^\s]+)(?:\s+([\s\S]*))?$/;

interface ResolveLCodeCustomCommandPromptOptions extends ListLCodeCustomCommandsOptions {
  /**
   * 本会话不可寻址的自定义命令名（小写）。与 `isReservedLCodeSlashCommandName` 是同一个
   * 概念的两个来源：那个是全局保留字，这个是调用方按会话下发的门禁，目前唯一使用者是
   * 动态工作流灰度关闭时的 `workflow`。
   * 刻意按**命令名**而不是禁用路径表达：`workflow` 来自随 CLI 打包的 lcode-guide 插件，
   * 其 SKILL/命令文件落在插件缓存目录，调用方拿不到稳定路径。
   */
  disabledCommandNames?: readonly string[];
  executionPort?: ExecutionPort;
  sessionId?: SessionId;
  signal?: AbortSignal;
  traceContext?: TraceContext;
}

export async function resolveLCodeCustomCommandPrompt(
  input: string,
  options: ResolveLCodeCustomCommandPromptOptions = {},
): Promise<string | undefined> {
  const invocation = parsePromptCustomCommandInvocation(input);
  if (!invocation || isReservedLCodeSlashCommandName(invocation.name)) {
    return undefined;
  }
  // 最小侵入点：这里是 `/name` 变成一条命令查找的唯一入口，也是保留字判定已经落脚的地方。
  // 放在 load 之前，被门禁挡住的命令连文件都不读；返回 undefined 与「命令不存在」同形，
  // 上层 input facade 会把原文当普通 prompt 交给模型，不会出现半展开的提示词。
  if (options.disabledCommandNames?.includes(invocation.name)) {
    return undefined;
  }

  try {
    const command = await loadLCodeCustomCommand({
      ...options,
      name: invocation.name,
    });
    if (options.executionPort) {
      // 调用 slash command 时先执行并替换输出，避免 unsupported error
      // 在 turn 创建前抛出后让 UI 长时间停在“正在思考”。
      //
      // 复用 contracts 的底层 template/format 函数，而非 expandCustomCommandPrompt：
      // 后者内部 detectUnsupportedDynamicSyntax 会对 `!` 语法直接抛错，而本路径
      // 恰恰要支持 shell 展开，只能在 expandCustomCommandTemplate 与
      // formatCustomCommandPrompt 之间插入 expandCustomCommandShellSyntax。
      const expanded = expandCustomCommandTemplate({
        args: invocation.args,
        command,
      });
      const body = await expandCustomCommandShellSyntax({
        command,
        content: expanded.body,
        executionPort: options.executionPort,
        sessionId: options.sessionId,
        signal: options.signal,
        traceContext: options.traceContext,
        workingDirectory: options.workingDirectory ?? process.cwd(),
      });
      return formatCustomCommandPrompt({
        argumentCount: expanded.argumentCount,
        body,
        command,
        usedArgumentsPlaceholder: expanded.usedArgumentsPlaceholder,
      }).prompt;
    }
    return expandCustomCommandPrompt({
      args: invocation.args,
      command,
    }).prompt;
  } catch (error) {
    if (error instanceof Error && CUSTOM_COMMAND_NOT_FOUND_PATTERN.test(error.message)) {
      return undefined;
    }
    throw error;
  }
}

function parsePromptCustomCommandInvocation(input: string): { args: string; name: string } | null {
  const match = PROMPT_CUSTOM_COMMAND_PATTERN.exec(input.trim());
  if (!match?.[1]) {
    return null;
  }
  return {
    args: match[2]?.trim() ?? "",
    name: match[1].toLowerCase(),
  };
}
