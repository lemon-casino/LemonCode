import { dirname, join } from "node:path";
import type {
  DependencyReceipt,
  RuntimeEnvironmentError,
  RuntimeEnvironmentRecord,
  RuntimePreparationOperation,
} from "@lcode/shared";
import type { ProjectDeclarations } from "../domain/declarations.js";
import {
  buildDependencyInstallPlan,
  isReceiptFresh,
  PNPM_IMPORT_METHOD_ENV,
} from "../domain/dependencies.js";
import type { DependencyInstallPort, RuntimeEnvironmentStore } from "./ports.js";

/**
 * preparingDependencies 编排（spec: specs/worktree-runtime-environments.md §11.1，P2-06）。
 * 收据覆盖声明指纹/锁/Node ABI/平台；新鲜收据跳过重装（幂等重试复用已完成步骤）；
 * 无锁文件不伪造 frozen 安装。进程属既有执行 owner，环境经 port 协调并保存收据。
 */

export interface DependencyStageParams {
  store: RuntimeEnvironmentStore;
  install?: DependencyInstallPort;
  /** 环境资源根（HostDataRoot 下），用于环境私有 TEMP（spec §8.3）。 */
  resourceRoot?: string;
  workspacePath: string;
  environmentId: string;
  declarations: ProjectDeclarations;
  declarationDigest: string;
  manifestOs: "windows" | "macos" | "linux";
  manifestArch: "x64" | "arm64";
  frozenTools: ReadonlyArray<{ key: string; version: string }>;
  installedToolPaths: Record<string, string>;
  stamp: () => string;
  fail: (error: RuntimeEnvironmentError) => Promise<RuntimePreparationOperation>;
}

/** 执行依赖阶段；返回失败结算的 operation，阶段完成/跳过返回 null。 */
export async function runDependencyStage(
  params: DependencyStageParams,
): Promise<RuntimePreparationOperation | null> {
  const plan = buildDependencyInstallPlan(params.declarations);
  if (!plan || !params.install) return null;
  const identity = {
    declarationDigest: params.declarationDigest,
    nodeVersion: params.frozenTools.find((tool) => tool.key === "node")?.version ?? "",
    platform: params.manifestOs,
    arch: params.manifestArch,
  };
  const existingReceipt = await params.store.readDependencyReceipt(params.environmentId);
  if (isReceiptFresh(existingReceipt, plan, identity)) return null;

  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const delimiter = process.platform === "win32" ? ";" : ":";
  const hostPath = process.env[pathKey] ?? process.env.PATH ?? "";
  // 冻结工具 PATH 前缀（用确切安装路径，确保装的是冻结版本）+ pnpm clone-or-copy
  // + 环境私有 TEMP（spec §8.3 resources/<id>/temp）。
  const toolDirs = [
    ...new Set(Object.values(params.installedToolPaths).map((toolPath) => dirname(toolPath))),
  ];
  const tempDir = params.resourceRoot
    ? join(params.resourceRoot, params.environmentId, "temp")
    : undefined;
  const depEnv: Record<string, string> = {
    ...PNPM_IMPORT_METHOD_ENV,
    ...(toolDirs.length
      ? { [pathKey]: [...toolDirs, hostPath].filter(Boolean).join(delimiter) }
      : {}),
    ...(tempDir ? { TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir } : {}),
  };
  try {
    const result = await params.install.install({
      cwd: params.workspacePath,
      command: plan.command,
      env: depEnv,
    });
    const receipt: DependencyReceipt = {
      environmentId: params.environmentId,
      manager: plan.manager,
      command: plan.command,
      strategy: "frozen",
      lockDigest: plan.lockDigest,
      declarationDigest: params.declarationDigest,
      nodeVersion: identity.nodeVersion,
      platform: params.manifestOs,
      arch: params.manifestArch,
      exitCode: result.exitCode,
      finishedAt: params.stamp(),
    };
    await params.store.saveDependencyReceipt(receipt);
    if (result.exitCode !== 0)
      return params.fail({
        code: "dependency-install-failed",
        stage: "preparingDependencies",
        message: `依赖安装失败 ${plan.command}（exit ${result.exitCode}）`,
        retryable: true,
      });
    return null;
  } catch (error) {
    return params.fail({
      code: "dependency-install-failed",
      stage: "preparingDependencies",
      message: `依赖安装失败：${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
    });
  }
}

/** 声明与记录参数的组合入参（service 侧一次性透传，保持此处签名稳定）。 */
export type DependencyStageContext = Pick<
  DependencyStageParams,
  "store" | "install" | "resourceRoot" | "stamp" | "fail"
>;

export function dependencyStageContext(
  service: { store: RuntimeEnvironmentStore },
  options: { dependencies?: DependencyInstallPort; dependencyResourceRoot?: string },
  record: RuntimeEnvironmentRecord,
  hooks: { stamp: () => string; fail: DependencyStageParams["fail"] },
): DependencyStageContext {
  return {
    store: service.store,
    install: options.dependencies,
    resourceRoot: options.dependencyResourceRoot,
    stamp: hooks.stamp,
    fail: hooks.fail,
  };
}
