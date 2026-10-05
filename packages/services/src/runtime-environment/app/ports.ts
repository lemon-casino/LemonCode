import { createHash } from "node:crypto";
import type { FrozenManifest, RuntimeEnvironmentRecord, RuntimePreparationOperation } from "@lcode/shared";
import type { ProjectDeclarations } from "../domain/declarations.js";

/**
 * app 层 port 定义（层向：adapters→app 允许，app→adapters 禁止）。
 * 组合根 node.ts 负责把 adapters 实现装配进 app 用例（spec §9.4）。
 */

/** 环境持久化 port（spec §8.2/§8.3）。 */
export interface RuntimeEnvironmentStore {
  lock(key: string, action: () => Promise<void>): Promise<void>;
  readEnvironment(id: string): Promise<RuntimeEnvironmentRecord | null>;
  saveEnvironment(record: RuntimeEnvironmentRecord): Promise<void>;
  listEnvironments(): Promise<RuntimeEnvironmentRecord[]>;
  readOperation(id: string): Promise<RuntimePreparationOperation | null>;
  saveOperation(operation: RuntimePreparationOperation): Promise<void>;
  readManifest(environmentId: string, revision: number): Promise<FrozenManifest | null>;
  saveManifest(environmentId: string, revision: number, manifest: FrozenManifest): Promise<void>;
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

/** AGENTS.md 身份规则：去重/绑定/持久化一律按 identity key，不按原始路径拼写。 */
export function identityKeyOf(scope: { workspacePath: string; workspaceIdentity?: string }): string {
  return scope.workspaceIdentity?.trim() || scope.workspacePath;
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
