import { createHash, randomUUID } from "node:crypto";
import { acquireFileLock } from "@lcode/shared/node";
import type {
  DependencyReceipt,
  FrozenManifest,
  ManagedServiceReceipt,
  RuntimeEnvironmentRecord,
  RuntimePreparationOperation,
} from "@lcode/shared";
import type { ProjectDeclarations } from "../domain/declarations.js";

/**
 * app 层 port 定义（层向：adapters→app 允许，app→adapters 禁止）。
 * 组合根 node.ts 负责把 adapters 实现装配进 app 用例（spec §9.4）。
 */

/** 环境持久化 port（spec §8.2/§8.3）。 */
export interface RuntimeEnvironmentStore {
  lock<T>(key: string, action: () => Promise<T>): Promise<T>;
  readEnvironment(id: string): Promise<RuntimeEnvironmentRecord | null>;
  saveEnvironment(record: RuntimeEnvironmentRecord): Promise<void>;
  listEnvironments(): Promise<RuntimeEnvironmentRecord[]>;
  readOperation(id: string): Promise<RuntimePreparationOperation | null>;
  saveOperation(operation: RuntimePreparationOperation): Promise<void>;
  readManifest(environmentId: string, revision: number): Promise<FrozenManifest | null>;
  saveManifest(environmentId: string, revision: number, manifest: FrozenManifest): Promise<void>;
  /** 每环境一份最新依赖收据；重装覆盖写（spec §11.1 P2-06）。 */
  readDependencyReceipt(environmentId: string): Promise<DependencyReceipt | null>;
  saveDependencyReceipt(receipt: DependencyReceipt): Promise<void>;
  /** 每环境每服务一份最新收据（spec §12.1 M3）；generation 随旧进程停止递增。 */
  readServiceReceipt(
    environmentId: string,
    serviceId: string,
  ): Promise<ManagedServiceReceipt | null>;
  saveServiceReceipt(receipt: ManagedServiceReceipt): Promise<void>;
  /** 已落收据的服务 ID 清单（投影遍历用，有界：每环境服务数量级）。 */
  listServiceIds(environmentId: string): Promise<string[]>;
  /** 读写均由环境 owner 持有同一环境锁，列表含防迟到请求的 released 墓碑。 */
  listConsumers(environmentId: string): Promise<import("@lcode/shared").RuntimeConsumerReference[]>;
  saveConsumers(
    environmentId: string,
    references: import("@lcode/shared").RuntimeConsumerReference[],
  ): Promise<void>;
  removeEnvironment(id: string): Promise<void>;
}

/** 工具后端 port（spec §5）：确切版本安装与可用性探测。 */
export interface ToolBackendPort {
  /** 确保后端本体就绪，返回后端可执行文件路径（缺失时按需下载）。 */
  ensureBackend(): Promise<string>;
  /** 安装确切工具版本并返回其可执行文件绝对路径。 */
  installTool(params: { key: string; version: string }): Promise<{ toolPath: string }>;
  /** 探测后端可用性（capabilities 用），不触发下载。 */
  probeBackend(): Promise<{ available: boolean; reason?: string }>;
}

/** 声明读取 port：读 cwd 下全部声明来源并做静态解析；实现负责存在性判断。 */
export interface DeclarationReaderPort {
  read(cwd: string): Promise<ProjectDeclarations>;
}

/** 依赖安装执行 port（spec §7：进程属既有执行 owner，环境经 port 协调并保存收据）。 */
export interface DependencyInstallPort {
  install(params: {
    cwd: string;
    command: string;
    /** 冻结覆盖键值（pnpm import method、TEMP/TMPDIR、cache 前缀）；spawn 时叠加。 */
    env: Record<string, string>;
    onOutput?: (output: string) => Promise<void>;
  }): Promise<{ exitCode: number; output: string }>;
}

/**
 * 托管服务进程 port（spec §12.1/§12.4，M3 P3-02）。
 * 进程属既有执行 owner；环境服务只保存收据。PID 仅诊断，停止授权经本 port。
 */
export interface ServiceProcessPort {
  start(params: {
    environmentId: string;
    serviceId: string;
    generation: number;
    argv: string[];
    cwd: string;
  }): Promise<{ pid?: number; urls: string[] }>;
  /** 停止并等待退出证明；无确认返回 undefined（不伪造 stopped）。 */
  stop(params: {
    environmentId: string;
    serviceId: string;
    generation: number;
    pid?: number;
  }): Promise<{ exitCode?: number } | undefined>;
  /** 进程意外退出回调：落盘 stopped 证明，running 收据不死后留存。 */
  onExit?(
    key: { environmentId: string; serviceId: string; generation: number },
    callback: (exitCode: number) => Promise<void>,
  ): void;
}

/** AGENTS.md 身份规则：去重/绑定/持久化一律按 identity key，不按原始路径拼写。 */
export function identityKeyOf(scope: {
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  return scope.workspaceIdentity?.trim() || scope.workspacePath;
}

/** 资源租约（spec §7/§12.4 M3 P3-01）：与 checkout writer 许可分开；活 owner 不按墙钟过期。 */
export interface ResourceLease {
  token: string;
  resourceKey: string;
  ownerId: string;
  release: () => Promise<void>;
}

/** 跨进程资源租约（复用 worktree coordinator 的文件锁模式；canonical path 键）。 */
export async function acquireResourceLease(params: {
  locksRoot: string;
  resourceKey: string;
  ownerId: string;
  waitMs?: number;
}): Promise<ResourceLease> {
  const key = createHash("sha256")
    .update(process.platform === "win32" ? params.resourceKey.toLowerCase() : params.resourceKey)
    .digest("hex");
  const lockPath = `${params.locksRoot.replace(/\\/g, "/")}/${key}.lock`;
  const release = await acquireFileLock(
    lockPath,
    [50, 100, 200, 500],
    10_000,
    params.waitMs ?? 30_000,
  );
  return {
    token: randomUUID(),
    resourceKey: params.resourceKey,
    ownerId: params.ownerId,
    release,
  };
}

/** 稳定 32 hex 哈希（幂等键基础；app 层允许 node:crypto）。 */
export function scopeKeyHash(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

/** 同 scope+requestId 重试必须落到同一 operation 记录（spec §10.3 幂等复用）。 */
export function operationIdFor(
  scope: { workspacePath: string; workspaceIdentity?: string },
  requestId: string,
): string {
  return scopeKeyHash(["operation", identityKeyOf(scope), requestId]);
}

/** 同 scope+binding+purpose 复用同一环境；binding 缺失时按 scope+purpose 共享。 */
export function environmentIdFor(
  scope: { workspacePath: string; workspaceIdentity?: string },
  bindingId: string | undefined,
  purpose: string,
): string {
  return scopeKeyHash(["environment", identityKeyOf(scope), bindingId ?? null, purpose]);
}
