import { JsInputJsonSchema } from "@lcode/contracts/tools/node-repl";
import { JS_TOOL_DESCRIPTION } from "@lcode/contracts/tools/node-repl";
import { totalmem } from "node:os";
import { join } from "node:path";
import { withRuntimeHeapLimit, resolveRuntimeHeapMb } from "@lcode/shared/node";
import type { McpServerConfig, PluginLoadOutcome } from "@lcode/contracts";
import { LCODE_PLUGIN_HOST_COMMAND } from "@lcode/contracts/plugins";
import { createBundledMcpRuntimeConfig } from "./official-plugin-runtime.js";
import {
  OFFICIAL_BROWSER_USE_PLUGIN_ID,
  OFFICIAL_CUA_PLUGIN_ID,
  OFFICIAL_NODE_REPL_HOST_PLUGIN_ID,
} from "./official-plugin-definitions.js";

const BUILT_IN_NODE_REPL_SERVER_NAME = "node_repl";

/**
 * node_repl 是官方能力共用的宿主工具，不是任何插件 manifest 声明的 plugin MCP。产物由独立的
 * `node-repl-host` seed 单元携带（无 listing、不对用户露出）；Browser Use 与 Computer Use
 * 各自只贡献自己的 skill、docs 与 native 依赖 root。
 */
export function resolveBuiltInNodeReplMcpServers(input: {
  pluginOutcome: Pick<PluginLoadOutcome, "plugins">;
  workingDirectory: string;
}): Record<string, McpServerConfig> {
  const browserUsePackage = input.pluginOutcome.plugins.find(
    (plugin) => plugin.id === OFFICIAL_BROWSER_USE_PLUGIN_ID && plugin.enabled,
  );
  const cuaPackage = input.pluginOutcome.plugins.find(
    (plugin) => plugin.id === OFFICIAL_CUA_PLUGIN_ID && plugin.enabled,
  );
  if (!browserUsePackage && !cuaPackage) return {};
  // 宿主自己不参与启用判断：它没有 skill、不对用户露出，缺失就意味着没有宿主可跑，
  // 必须安全地不注册，而不是回退到某个插件包里的旧产物。
  const hostPackage = input.pluginOutcome.plugins.find(
    (plugin) => plugin.id === OFFICIAL_NODE_REPL_HOST_PLUGIN_ID,
  );
  if (!hostPackage) return {};

  const nodeRepl = createBundledMcpRuntimeConfig({
    cwd: input.workingDirectory,
    env: {
      // 领域 root 各自注入，且只在对应能力启用时注入：宿主据此决定哪一半文档可用。
      // 旧名兼容：旧插件仍读 ZCODE_PLUGIN_ROOT，双名注入同一取值。
      ...(browserUsePackage
        ? {
            LCODE_PLUGIN_ROOT: browserUsePackage.rootPath,
            ZCODE_PLUGIN_ROOT: browserUsePackage.rootPath,
          }
        : {}),
      ...(cuaPackage ? { LCODE_CUA_PLUGIN_ROOT: cuaPackage.rootPath } : {}),
    },
    rootPath: hostPackage.rootPath,
    timeoutMs: 600_000,
  });
  if (!nodeRepl) return {};
  const constrained = process.constrainedMemory?.() || totalmem();
  const heapMb = resolveRuntimeHeapMb("repl-worker", Math.min(constrained, totalmem()));
  // Node 的进程级堆参数会覆盖 Worker resourceLimits；此独立宿主必须使用同一执行预算。
  if (nodeRepl.type === "stdio") {
    // 普通 Node 可直接承载可信内置宿主，避免先解析整份 CLI；SEA 必须保留自 re-exec 协议。
    if (nodeRepl.args?.[0] !== LCODE_PLUGIN_HOST_COMMAND) {
      nodeRepl.args = [...process.execArgv, join(hostPackage.rootPath, "dist", "mcp", "server.js")];
    }
    nodeRepl.env = {
      ...nodeRepl.env,
      NODE_OPTIONS: withRuntimeHeapLimit(process.env.NODE_OPTIONS, heapMb),
    };
    let skipValue = false;
    nodeRepl.args = nodeRepl.args?.filter((arg) => {
      if (skipValue) {
        skipValue = false;
        return false;
      }
      if (/^--max[-_]old[-_]space[-_]size$/.test(arg)) {
        skipValue = true;
        return false;
      }
      return !/^--max[-_]old[-_]space[-_]size=/.test(arg);
    });
  }
  return {
    [BUILT_IN_NODE_REPL_SERVER_NAME]: {
      ...nodeRepl,
      source: { kind: "builtin" },
      onDemandTools: [
        { toolName: "js", description: JS_TOOL_DESCRIPTION, inputSchema: JsInputJsonSchema },
      ],
      isolation: "workspace",
      protocolVersion: "2026-07-28",
    },
  };
}
