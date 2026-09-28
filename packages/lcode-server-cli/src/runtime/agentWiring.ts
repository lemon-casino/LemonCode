import { access } from "node:fs/promises";
import { join } from "node:path";

export interface BundledAgentWiring {
  LCODE_AGENT_SERVER_COMMAND: string;
  LCODE_AGENT_SERVER_ARGS_JSON: string;
}

export function createReleaseAgentWiring(
  runtimeRoot: string,
  runtimeNode: string,
  env: Record<string, string | undefined>,
): BundledAgentWiring | null {
  if (env.LCODE_AGENT_SERVER_COMMAND?.trim()) return null;
  return {
    LCODE_AGENT_SERVER_COMMAND: runtimeNode,
    LCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([
      join(runtimeRoot, "lcode.cjs"),
      "app-server",
      "--stdio",
    ]),
  };
}

/**
 * 发行包内 Core 既不在 monorepo、也没有 Electron runtime，`lcodeAgentProcessManager`
 * 的默认解析链（monorepo dev → Electron → 远端已部署 binary）会全部落空。这里把随包
 * `lcode.cjs` 注入为 agent 启动命令；env 覆盖是该解析链的最高优先级，因此显式配置的
 * `LCODE_AGENT_SERVER_COMMAND` 永远优先，开发态（入口同目录无 lcode.cjs）不受影响。
 */
export async function resolveBundledAgentWiring(
  entryDir: string,
  env: Record<string, string | undefined>,
): Promise<BundledAgentWiring | null> {
  if (env.LCODE_AGENT_SERVER_COMMAND?.trim()) {
    return null;
  }
  const bundlePath = join(entryDir, "lcode.cjs");
  try {
    await access(bundlePath);
  } catch {
    return null;
  }
  return {
    LCODE_AGENT_SERVER_COMMAND: process.execPath,
    LCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([bundlePath, "app-server", "--stdio"]),
  };
}
