import { BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES, type ZCodeSlashCommand } from "@zcode/shared";
import {
  listZCodeCustomCommands,
  type ListZCodeCustomCommandsOptions,
} from "../custom-commands.js";
import {
  APP_PROTOCOL_APP_ONLY_BUILTIN_SLASH_COMMANDS,
  APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES,
  isReservedZCodeSlashCommandName,
} from "../slash-command-surface.js";

/**
 * 这些内置命令都依赖 dynamic workflow 工具簇。Bug 原因是只过滤 `/workflow` 会在远端
 * 显式关闭能力时留下可见但不可执行的 `/lemon`；目录装配必须使用同一门禁一起剔除。
 */
const DYNAMIC_WORKFLOW_SLASH_COMMAND_NAMES = new Set(["workflow", "lemon"]);

export interface ListProtocolSlashCommandsOptions extends ListZCodeCustomCommandsOptions {
  /**
   * 动态工作流灰度门。**只有显式 false
   * 才剔除**依赖工作流的命令：CLI 自身的目录装配（TUI / 未参与灰度的调用方）缺席该字段，
   * 必须保持原样。协议服务端一律从 appRuntimePreferences 传入显式布尔。
   */
  dynamicWorkflowEnabled?: boolean;
}

export async function listProtocolSlashCommands(
  options: ListProtocolSlashCommandsOptions = {},
): Promise<ZCodeSlashCommand[]> {
  const builtins = listAppProtocolBuiltinSlashCommands();
  let customCommands: Awaited<ReturnType<typeof listZCodeCustomCommands>>["commands"] = [];
  try {
    const outcome = await listZCodeCustomCommands(options);
    customCommands = outcome.commands;
  } catch {
    // 自定义命令发现失败不应阻断 session snapshot；保留可执行的内置协议命令。
    customCommands = [];
  }

  return pinWorkflowAfterGoal([
    ...builtins,
    ...customCommands
      .filter((command) => !command.disableNonInteractive)
      .filter((command) => !isReservedZCodeSlashCommandName(command.name))
      // 灰度关闭：composer 的加号菜单与 `/` 面板都只读这份目录，剔除即两个入口一起消失。开启时后面的 pinWorkflowAfterGoal 继续把 `/workflow` 钉在 goal 之后。
      .filter(
        (command) =>
          options.dynamicWorkflowEnabled !== false ||
          !DYNAMIC_WORKFLOW_SLASH_COMMAND_NAMES.has(command.name),
      )
      .map((command) => ({
        description: command.description,
        inputHint: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
        name: command.name,
        source: "custom" as const,
      })),
  ]);
}

/**
 * App `/` 面板按本目录顺序展示，本函数是唯一的排序点（UI 不维护排序白名单）。
 * `workflow` 是 zcode-guide 内置插件的自定义命令，
 * 按发现顺序会沉在 custom 段末尾；产品要求它与 `goal` 一样作为「开启一段工作」的入口，
 * 紧随 goal 之后。
 * 只调顺序：来源、去重与 reserved 规则不变；任一方缺席时保持原序。
 */
function pinWorkflowAfterGoal(commands: ZCodeSlashCommand[]): ZCodeSlashCommand[] {
  const workflowIndex = commands.findIndex(
    (command) => command.name === "workflow",
  );
  if (workflowIndex < 0 || !commands.some((command) => command.name === "goal")) return commands;
  const [workflow] = commands.splice(workflowIndex, 1);
  const goalIndex = commands.findIndex((command) => command.name === "goal");
  commands.splice(goalIndex + 1, 0, workflow!);
  return commands;
}

function listAppProtocolBuiltinSlashCommands(): ZCodeSlashCommand[] {
  const sharedBuiltins = APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES.flatMap((name) => {
    const command = BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES.find((entry) => entry.name === name);
    if (!command) return [];
    return [
      {
        description: command.summary,
        inputHint: command.usage,
        name: command.name,
        source: "builtin" as const,
      },
    ];
  });
  return [...sharedBuiltins, ...APP_PROTOCOL_APP_ONLY_BUILTIN_SLASH_COMMANDS];
}
