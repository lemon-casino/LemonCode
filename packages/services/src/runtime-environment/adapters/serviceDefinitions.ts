import { open } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeEnvironmentProjection, RuntimeEnvironmentRecord } from "@lcode/shared";
import type { ResolvedProjectExecutionContext } from "../contract.js";
import type { ServiceDefinition } from "../domain/services.js";
import { managerCommand } from "./dependencyInstall.js";

export const BUILTIN_SERVICE_PROCESSES = {
  "dev:web": { portEnvironment: ["LCODE_SERVER_PORT", "LCODE_WEB_PORT"] },
  "dev:server": { portEnvironment: ["LCODE_SERVER_PORT"] },
  "dev:desktop": { portEnvironment: ["LCODE_DESKTOP_PORT"] },
} as const;
async function packageInfo(
  cwd: string,
): Promise<{ name?: string; scripts?: Record<string, string> }> {
  let file;
  try {
    file = await open(join(cwd, "package.json"), "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new Error("unsupported-declaration: package scripts exceed read limit");
    const value: unknown = JSON.parse(await file.readFile("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const pkg = value as Record<string, unknown>;
    const scripts =
      pkg.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts)
        ? Object.fromEntries(
            Object.entries(pkg.scripts).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string" && entry[1].length > 0 && entry[1].length <= 8192,
            ),
          )
        : {};
    return { name: typeof pkg.name === "string" ? pkg.name : undefined, scripts };
  } finally {
    await file.close();
  }
}
export async function listProjectServices(
  record: RuntimeEnvironmentRecord,
): Promise<NonNullable<RuntimeEnvironmentProjection["availableServices"]>> {
  const pkg = await packageInfo(record.scope.workspacePath);
  if (pkg.name === "lcode")
    return Object.keys(BUILTIN_SERVICE_PROCESSES)
      .filter((key) => pkg.scripts?.[key])
      .map((serviceId) => ({ serviceId, portIsolation: "managed" }));
  // 未适配框架不把 PORT 当通用隔离接口；只提供明确的 dev 脚本与真实输出地址。
  return pkg.scripts?.dev ? [{ serviceId: "dev", portIsolation: "unmanaged" }] : [];
}
export async function resolveProjectService(
  record: RuntimeEnvironmentRecord,
  serviceId: string,
  context: ResolvedProjectExecutionContext,
): Promise<ServiceDefinition | null> {
  if (!(await listProjectServices(record)).some((item) => item.serviceId === serviceId))
    return null;
  const manager = context.toolPaths.pnpm ? "pnpm" : "npm";
  const command = await managerCommand(manager, context.toolPaths);
  return {
    serviceId,
    purpose: "development",
    cwd: record.scope.workspacePath,
    argv:
      serviceId === "dev:desktop"
        ? [
            context.toolPaths.node!,
            join(record.scope.workspacePath, "scripts", "dev-desktop-env.mjs"),
            "production",
            "--runtime-only",
          ]
        : [command.executable, ...command.prefix, "run", serviceId],
    writesSource: false,
  };
}
