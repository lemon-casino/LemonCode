import type {
  FrozenManifest,
  RuntimeEnvironmentCapabilities,
  RuntimeEnvironmentError,
  RuntimeEnvironmentProjection,
  RuntimeEnvironmentRecord,
  RuntimePreparationOperation,
} from "@lcode/shared";
import type { IRuntimeEnvironmentService, RuntimeEnvironmentPrepareRequest } from "../contract.js";
import type {
  RuntimeEnvironmentStore,
  ToolBackendPort,
  DeclarationReaderPort,
  DependencyInstallPort,
} from "./ports.js";
import { environmentIdFor, operationIdFor } from "./ports.js";
import { advanceStatus } from "../domain/state.js";
import { digestDeclarations } from "../domain/declarations.js";
import { selectToolsForFreeze } from "../domain/selectTools.js";
import { runDependencyStage } from "./dependencyStage.js";
import { projectEnvironment } from "./projection.js";
import { queryFrozenContext, queryFrozenContextForCwd } from "./frozenContext.js";
import { releaseRuntimeEnvironment } from "./consumerLifecycle.js";

/**
 * 环境生命周期用例（spec: specs/worktree-runtime-environments.md §10）。
 * 状态唯一 owner = 本服务；同 requestId 幂等复用操作与环境；
 * 取消结算持久化不复活；查询不产生执行。
 */

export interface RuntimeEnvironmentServiceOptions {
  store: RuntimeEnvironmentStore;
  backend: ToolBackendPort;
  /** 声明读取 port：平台 IO 在 adapters，测试用内存实现。 */
  declarations: DeclarationReaderPort;
  now?: () => Date;
  /** 缺能力时 capabilities 给 missingReason，不伪造托管成功（spec §9.5）。 */
  managed?: boolean;
  missingReason?: string;
  /** 应用默认工具（无声明时冻结来源标注 app-default，spec §6.1）。 */
  appDefaultTools?: ReadonlyArray<{ key: string; version: string }>;
  backendVersion?: string;
  /**
   * 依赖安装 port（spec §11.1，P2-06）；缺省 = 跳过依赖安装阶段（纯工具准备）。
   * 进程属既有执行 owner；环境经 port 协调并保存收据。
   */
  dependencies?: DependencyInstallPort;
  /** 环境资源根（如 HostDataRoot/runtime-environments/resources），用于环境私有 TEMP。 */
  dependencyResourceRoot?: string;
}

const APP_DEFAULTS: ReadonlyArray<{ key: string; version: string }> = [
  { key: "node", version: "24.14.0" },
  { key: "pnpm", version: "10.33.2" },
];

function platformOs(): "windows" | "macos" | "linux" {
  return process.platform === "win32"
    ? "windows"
    : process.platform === "darwin"
      ? "macos"
      : "linux";
}

export function createRuntimeEnvironmentService(
  options: RuntimeEnvironmentServiceOptions,
): IRuntimeEnvironmentService {
  const { store, backend, declarations: reader } = options;
  const now = options.now ?? (() => new Date());
  const managed = options.managed ?? true;
  const appDefaults = options.appDefaultTools ?? APP_DEFAULTS;
  const backendVersion = options.backendVersion ?? "v2026.10.2";

  function stamp(): string {
    return now().toISOString();
  }

  async function readEnvironment(id: string): Promise<RuntimeEnvironmentRecord | null> {
    return store.readEnvironment(id);
  }

  async function saveStage(
    operation: RuntimePreparationOperation,
    record: RuntimeEnvironmentRecord,
    stage: RuntimePreparationOperation["stage"],
  ): Promise<void> {
    const at = stamp();
    await store.saveOperation({ ...operation, stage, updatedAt: at });
    await store.saveEnvironment({ ...record, status: stage, updatedAt: at });
  }

  async function failOperation(
    operation: RuntimePreparationOperation,
    record: RuntimeEnvironmentRecord,
    error: RuntimeEnvironmentError,
  ): Promise<RuntimePreparationOperation> {
    const at = stamp();
    const failed = { ...operation, status: "failed" as const, error, updatedAt: at };
    await store.saveOperation(failed);
    await store.saveEnvironment({ ...record, status: "failed", error, updatedAt: at });
    return failed;
  }

  // UI 只读投影（spec §9.2）；实现见 projection.ts，manifest 缺失时工具列表为空。
  const projection = (record: RuntimeEnvironmentRecord) => projectEnvironment(store, record);

  return {
    async getCapabilities(): Promise<RuntimeEnvironmentCapabilities> {
      if (!managed)
        return {
          managedEnvironments: false,
          ...(options.missingReason ? { missingReason: options.missingReason } : {}),
        };
      const probe = await backend.probeBackend();
      return {
        managedEnvironments: true,
        platform: platformOs(),
        backend: {
          kind: "mise",
          version: backendVersion,
          available: probe.available,
        },
        ...(probe.available ? {} : { missingReason: probe.reason ?? "backend-not-installed" }),
      };
    },

    async prepare(params: RuntimeEnvironmentPrepareRequest) {
      const opId = operationIdFor(params, params.requestId);
      const envId = environmentIdFor(params, params.bindingId, params.purpose);
      const at = stamp();

      // 幂等复用（spec §10.3）：succeeded/running 直接返回；cancelled 是结算态不复活；
      // failed 复用同一 operationId/environmentId 重跑（重试指向原操作，不新建环境）。
      const existing = await store.readOperation(opId);
      if (existing && existing.status !== "failed") {
        if (!params.cancel) return existing;
        if (existing.status !== "running") return existing;
        const cancelled: RuntimePreparationOperation = {
          ...existing,
          status: "cancelled",
          cancelRequested: true,
          updatedAt: at,
        };
        await store.saveOperation(cancelled);
        const env = await readEnvironment(envId);
        if (env && env.status !== "cancelled" && env.status !== "released") {
          await store.saveEnvironment({ ...env, status: "cancelled", updatedAt: at });
        }
        return cancelled;
      }

      if (params.cancel) {
        // 取消先于任何记录：持久化取消结算，不复活首次输入（spec §10.3）。
        const cancelled: RuntimePreparationOperation = {
          operationId: opId,
          requestId: params.requestId,
          environmentId: envId,
          status: "cancelled",
          stage: "resolvingTools",
          cancelRequested: true,
          createdAt: at,
          updatedAt: at,
        };
        await store.saveOperation(cancelled);
        return cancelled;
      }

      const operation: RuntimePreparationOperation = {
        operationId: opId,
        requestId: params.requestId,
        environmentId: envId,
        status: "running",
        stage: "resolvingTools",
        cancelRequested: false,
        createdAt: at,
        updatedAt: at,
      };
      await store.saveOperation(operation);
      const record: RuntimeEnvironmentRecord = {
        environmentId: envId,
        scope: {
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        },
        ...(params.bindingId ? { bindingId: params.bindingId } : {}),
        purpose: params.purpose,
        status: "resolvingTools",
        currentRevision: 0,
        createdAt: at,
        updatedAt: at,
      };
      await store.saveEnvironment(record);

      // resolvingTools：静态解析声明（P1-03）；冲突/不支持 → failed 不猜测。
      const parsed = await reader.read(params.workspacePath);
      const { tools, issues } = selectToolsForFreeze(parsed, appDefaults);
      if (issues.length > 0) {
        return failOperation(operation, record, {
          code: issues[0]!.code,
          stage: "resolvingTools",
          message: issues[0]!.message,
          retryable: issues[0]!.code === "configuration-conflict",
          detail: {
            source: issues[0]!.source,
            ...(issues[0]!.field ? { field: issues[0]!.field } : {}),
          },
        });
      }

      // 冻结 manifest：revision 内不可变；同声明指纹复用已有 manifest（spec §6.2）。
      const digest = digestDeclarations(parsed);
      const manifest: FrozenManifest = {
        schemaVersion: 1,
        backendVersion,
        os: platformOs(),
        arch: process.arch === "arm64" ? "arm64" : "x64",
        tools: tools.map((tool) => ({ ...tool })),
        declarationDigest: digest,
        installStrategy:
          parsed.lockfiles.length > 0 && !parsed.ambiguousLocks ? "frozen" : "non-frozen",
        createdAt: at,
      };
      await store.saveManifest(envId, 1, manifest);

      const installing = advanceStatus("resolvingTools", "step").status;
      await saveStage(operation, record, installing);

      // installingTools：确切版本经后端安装；真实下载/校验/互斥在后端（P1-04）。
      const installed: Record<string, string> = {};
      for (const tool of tools) {
        try {
          const { toolPath } = await backend.installTool({ key: tool.key, version: tool.version });
          installed[tool.key] = toolPath;
        } catch (error) {
          return failOperation(operation, record, {
            code: "download-failed",
            stage: "installingTools",
            message: `工具安装失败 ${tool.key}@${tool.version}：${error instanceof Error ? error.message : String(error)}`,
            retryable: true,
          });
        }
      }

      // preparingDependencies：依赖安装（spec §11.1，P2-06），编排在 dependencyStage.ts。
      const preparing = advanceStatus(installing, "step").status;
      await saveStage(operation, record, preparing);
      const failedDependency = await runDependencyStage({
        store,
        install: options.dependencies,
        resourceRoot: options.dependencyResourceRoot,
        workspacePath: params.workspacePath,
        environmentId: envId,
        declarations: parsed,
        declarationDigest: digest,
        manifestOs: manifest.os,
        manifestArch: manifest.arch,
        frozenTools: tools,
        installedToolPaths: installed,
        stamp,
        fail: (error) => failOperation(operation, record, error),
      });
      if (failedDependency) return failedDependency;

      // ready：状态机推进（依赖收据成功或非冻结策略后结算）。
      const finalStatus = advanceStatus(preparing, "ready").status;
      const finalManifest: FrozenManifest = {
        ...manifest,
        tools: manifest.tools.map((tool) =>
          installed[tool.key]
            ? {
                ...tool,
                toolPath: installed[tool.key],
                installStrategy: "managed-tool-store" as const,
              }
            : tool,
        ),
      };
      await store.saveManifest(envId, 1, finalManifest);
      const doneAt = stamp();
      const done: RuntimePreparationOperation = {
        ...operation,
        status: "succeeded",
        stage: finalStatus,
        updatedAt: doneAt,
      };
      await store.saveOperation(done);
      await store.saveEnvironment({
        ...record,
        status: finalStatus,
        currentRevision: 1,
        updatedAt: doneAt,
      });
      return done;
    },

    async get(params) {
      if (params.environmentId) {
        const record = await readEnvironment(params.environmentId);
        return record ? projection(record) : null;
      }
      // requestId 维度：操作记录指向 environmentId，按原 purpose 查询（spec §9.1 get）。
      const operation = await store.readOperation(operationIdFor(params, params.requestId!));
      if (!operation) return null;
      const record = await readEnvironment(operation.environmentId);
      return record ? projection(record) : null;
    },

    async list(params) {
      const all = await store.listEnvironments();
      const result: RuntimeEnvironmentProjection[] = [];
      for (const record of all) {
        const recordIdentity = record.scope.workspaceIdentity?.trim() || record.scope.workspacePath;
        const queryIdentity = params.workspaceIdentity?.trim() || params.workspacePath;
        if (recordIdentity !== queryIdentity) continue;
        result.push(await projection(record));
      }
      return result;
    },

    resolveContext: (params) => queryFrozenContext(store, params),
    resolveContextForCwd: (params) => queryFrozenContextForCwd(store, params),
    release: (params) => releaseRuntimeEnvironment(store, params, stamp),

    async reconcile(params) {
      const operation = await store.readOperation(operationIdFor(params, params.requestId));
      const record =
        operation === null
          ? await readEnvironment(environmentIdFor(params, undefined, "worktree"))
          : await readEnvironment(operation.environmentId);
      return {
        operation,
        environment: record ? await projection(record) : null,
      };
    },
  };
}
