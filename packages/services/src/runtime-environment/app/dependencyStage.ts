import { dirname, join } from "node:path";
import type {
  DependencyReceipt,
  FrozenManifest,
  RuntimeEnvironmentError,
  RuntimePreparationOperation,
} from "@lcode/shared";
import type { ProjectDeclarations } from "../domain/declarations.js";
import {
  buildDependencyInstallPlan,
  isReceiptFresh,
  PNPM_IMPORT_METHOD_ENV,
} from "../domain/dependencies.js";
import type { DependencyInstallPort, RuntimeEnvironmentStore } from "./ports.js";
import { safeEnvironmentError } from "./manifest.js";

export interface DependencyStageParams {
  store: RuntimeEnvironmentStore;
  install?: DependencyInstallPort;
  resourceRoot?: string;
  resources?: FrozenManifest["resources"];
  workspacePath: string;
  environmentId: string;
  declarations: ProjectDeclarations;
  declarationDigest: string;
  manifestDigest?: string;
  manifestOs: "windows" | "macos" | "linux";
  manifestArch: "x64" | "arm64";
  frozenTools: ReadonlyArray<{ key: string; version: string }>;
  installedToolPaths: Record<string, string>;
  stamp: () => string;
  signal?: AbortSignal;
  checkpoint?: () => Promise<void>;
  fail: (error: RuntimeEnvironmentError) => Promise<RuntimePreparationOperation>;
}
export async function runDependencyStage(
  params: DependencyStageParams,
): Promise<RuntimePreparationOperation | null> {
  const plan = buildDependencyInstallPlan(params.declarations);
  if (!plan) return null;
  if (!params.install)
    return params.fail({
      code: "capability-unavailable",
      stage: "preparingDependencies",
      retryable: true,
      message: "dependency install owner is unavailable; a frozen lock cannot be marked ready",
    });
  const identity = {
    declarationDigest: params.declarationDigest,
    manifestDigest: params.manifestDigest,
    nodeVersion: params.frozenTools.find((tool) => tool.key === "node")?.version ?? "",
    managerVersion:
      params.frozenTools.find((tool) => tool.key === plan.manager)?.version ?? plan.managerVersion,
    platform: params.manifestOs,
    arch: params.manifestArch,
  };
  const existing = await params.store.readDependencyReceipt(params.environmentId);
  if (isReceiptFresh(existing, plan, identity)) return null;
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const delimiter = process.platform === "win32" ? ";" : ":";
  const hostPath =
    Object.entries(process.env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const dirs = [
    ...new Set(Object.values(params.installedToolPaths).map((toolPath) => dirname(toolPath))),
  ];
  const temp =
    params.resources?.temp ??
    (params.resourceRoot ? join(params.resourceRoot, params.environmentId, "temp") : undefined);
  const env: Record<string, string> = {
    ...PNPM_IMPORT_METHOD_ENV,
    [pathKey]: [...dirs, hostPath].filter(Boolean).join(delimiter),
    ...(temp ? { TEMP: temp, TMP: temp, TMPDIR: temp } : {}),
    ...(params.resources
      ? {
          npm_config_cache: params.resources.cache,
          npm_config_store_dir: params.resources.packageStore,
          npm_config_prefix: join(params.resources.cache, "global"),
          LCODE_RUNTIME_ENVIRONMENT_ID: params.environmentId,
          LCODE_DATA_BASE_DIR: params.resources.data,
        }
      : {}),
  };
  try {
    const result = await params.install.install({
      cwd: params.workspacePath,
      command: plan.command,
      manager: plan.manager,
      managerVersion: identity.managerVersion,
      toolPaths: params.installedToolPaths,
      env,
      signal: params.signal,
    });
    await params.checkpoint?.();
    const receipt: DependencyReceipt = {
      environmentId: params.environmentId,
      manager: plan.manager,
      command: plan.command,
      strategy: "frozen",
      lockDigest: plan.lockDigest,
      ...identity,
      exitCode: result.exitCode,
      finishedAt: params.stamp(),
    };
    await params.store.lock(params.environmentId, async () => {
      const record = await params.store.readEnvironment(params.environmentId);
      // 取消请求与收据写入共享 fence；不得把取消之后的退出结果当成可复用成功证明。
      if (record?.status === "cancelling" || params.signal?.aborted) return;
      await params.store.saveDependencyReceipt(receipt);
    });
    if (result.exitCode !== 0)
      return params.fail({
        code: "dependency-install-failed",
        stage: "preparingDependencies",
        retryable: true,
        message: `依赖安装失败 ${plan.command}（exit ${result.exitCode}）`,
        diagnostic: {
          environmentId: params.environmentId,
          command: plan.command,
          exitCode: result.exitCode,
          stderrTail: safeEnvironmentError(result.output),
        },
      });
    return null;
  } catch (error) {
    return params.fail({
      code: "dependency-install-failed",
      stage: "preparingDependencies",
      retryable: true,
      message: safeEnvironmentError(error),
    });
  }
}
