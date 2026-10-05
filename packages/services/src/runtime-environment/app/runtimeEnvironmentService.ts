import { randomUUID } from "node:crypto";
import type {
  FrozenManifest,
  RuntimeEnvironmentCapabilities,
  RuntimeEnvironmentError,
  RuntimeEnvironmentProjection,
  RuntimeEnvironmentRecord,
  RuntimePreparationOperation,
} from "@lcode/shared";
import type {
  IRuntimeEnvironmentService,
  RuntimeEnvironmentPrepareRequest,
  ResolvedProjectExecutionContext,
} from "../contract.js";
import type {
  RuntimeEnvironmentStore,
  ToolBackendPort,
  DeclarationReaderPort,
} from "./ports.js";
import { environmentIdFor, operationIdFor } from "./ports.js";
import { advanceStatus, isConsumableStatus } from "../domain/state.js";
import { digestDeclarations } from "../domain/declarations.js";
import { selectToolsForFreeze } from "../domain/selectTools.js";

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

  async function projection(
    record: RuntimeEnvironmentRecord,
  ): Promise<RuntimeEnvironmentProjection> {
    const manifest = await store.readManifest(record.environmentId, record.currentRevision);
    return {
      environmentId: record.environmentId,
      purpose: record.purpose,
      status: record.status,
      currentRevision: record.currentRevision,
      tools: manifest?.tools ?? [],
      ...(manifest ? { manifestDigest: manifest.declarationDigest } : {}),
      ...(manifest ? { installStrategy: manifest.installStrategy } : {}),
      ...(record.error ? { error: record.error } : {}),
      updatedAt: record.updatedAt,
    };
  }

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
        ...(probe.available
          ? {}
          : { missingReason: probe.reason ?? "backend-not-installed" }),
      };
    },

    async prepare(params: RuntimeEnvironmentPrepareRequest) {
      const opId = operationIdFor(params, params.requestId);
      const envId = environmentIdFor(params, params.bindingId, params.purpose);
      const at = stamp();

      // 幂等复用：同 requestId 已有 operation 直接返回/结算取消，不新建环境（spec §10.3）。
      const existing = await store.readOperation(opId);
      if (existing) {
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
          detail: { source: issues[0]!.source, ...(issues[0]!.field ? { field: issues[0]!.field } : {}) },
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

      // ready：状态机推进（依赖阶段 M2 接入实际安装用例，当前直接结算 ready）。
      const afterInstall = advanceStatus(installing, "step").status;
      const finalStatus = advanceStatus(afterInstall, "ready").status;
      const finalManifest: FrozenManifest = {
        ...manifest,
        tools: manifest.tools.map((tool) =>
          installed[tool.key]
            ? { ...tool, toolPath: installed[tool.key], installStrategy: "managed-tool-store" as const }
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
        const recordIdentity =
          record.scope.workspaceIdentity?.trim() || record.scope.workspacePath;
        const queryIdentity = params.workspaceIdentity?.trim() || params.workspacePath;
        if (recordIdentity !== queryIdentity) continue;
        result.push(await projection(record));
      }
      return result;
    },

    async resolveContext(params): Promise<ResolvedProjectExecutionContext> {
      const record = await readEnvironment(params.environmentId);
      if (!record) throw new Error(`Runtime environment ${params.environmentId} not found`);
      if (!isConsumableStatus(record.status))
        throw new Error(
          `Runtime environment ${params.environmentId} is ${record.status}, not consumable`,
        );
      const manifest = await store.readManifest(record.environmentId, record.currentRevision);
      if (!manifest)
        throw new Error(`Runtime environment ${params.environmentId} has no frozen manifest`);
      const toolPaths: Record<string, string> = {};
      for (const tool of manifest.tools) {
        if (tool.toolPath) toolPaths[tool.key] = tool.toolPath;
      }
      // 每命令一份不可变上下文；token 仅内部，不进协议与 UI（spec §9.2）。
      return {
        environmentId: record.environmentId,
        revision: record.currentRevision,
        manifestDigest: manifest.declarationDigest,
        executionScope: {
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        },
        cwd: params.workspacePath,
        toolPaths,
        envOverlay: { base: "inherit", set: {}, unset: [] },
        resourceLeaseToken: `lease-${randomUUID()}`,
      };
    },

    async release(params) {
      const record = await readEnvironment(params.environmentId);
      if (!record) return { status: "released" as const };
      // stale 防护：旧代 release 请求不得覆盖新代（spec §9.5）。
      if (params.expectedRevision !== undefined && params.expectedRevision !== record.currentRevision)
        return {
          status: "releaseBlocked" as const,
          reason: `stale-reference: expected revision ${params.expectedRevision}, current ${record.currentRevision}`,
        };
      let blocked: string | undefined;
      await store.lock(record.environmentId, async () => {
        const current = (await readEnvironment(params.environmentId)) ?? record;
        const releasing = advanceStatus(current.status, "release");
        if (releasing.invalid) {
          blocked = `environment ${current.status} cannot release`;
          return;
        }
        await store.saveEnvironment({
          ...current,
          status: "releasing",
          updatedAt: stamp(),
        });
        // fence 已拒绝新消费者；进程停止证明由进程 owner 在 M2/M3 接线，当前直接结算。
        await store.saveEnvironment({
          ...current,
          status: "released",
          updatedAt: stamp(),
        });
      });
      return blocked ? { status: "releaseBlocked" as const, reason: blocked } : { status: "released" as const };
    },

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
