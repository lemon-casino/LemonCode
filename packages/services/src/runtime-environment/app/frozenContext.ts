import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { runtimeEnvironmentScopeSchema, type RuntimeEnvironmentRecord } from "@lcode/shared";
import type {
  ResolvedProjectExecutionContext,
  RuntimeEnvironmentResolveRequest,
} from "../contract.js";
import { isConsumableStatus } from "../domain/state.js";
import { identityKeyOf, type RuntimeEnvironmentStore } from "./ports.js";

const text = z.string().trim().min(1).max(4096);
const querySchema = runtimeEnvironmentScopeSchema
  .extend({
    environmentId: z.string().regex(/^[a-f0-9]{32}$/),
    consumer: text,
    expectedRevision: z.number().int().positive().optional(),
    expectedManifestDigest: text.optional(),
    bindingId: text.optional(),
    cwd: text.optional(),
  })
  .strict();
const cwdQuerySchema = z
  .object({ cwd: text, consumer: text, workspaceIdentity: text.optional() })
  .strict();

function normalized(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function contains(root: string, path: string): boolean {
  const child = relative(normalized(root), normalized(path));
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

/** 匹配包含回收中记录；不能跳过 fence 后把受管目录误当作非托管。 */
export function matchEnvironmentForCwd(
  records: RuntimeEnvironmentRecord[],
  cwd: string,
): RuntimeEnvironmentRecord | null {
  const matches = records.filter((record) => contains(record.scope.workspacePath, cwd));
  matches.sort((left, right) => right.scope.workspacePath.length - left.scope.workspacePath.length);
  if (
    matches.length > 1 &&
    normalized(matches[0]!.scope.workspacePath) === normalized(matches[1]!.scope.workspacePath)
  )
    throw new Error("scope-mismatch: ambiguous runtime environment path");
  return matches[0] ?? null;
}

export async function queryFrozenContext(
  store: RuntimeEnvironmentStore,
  input: RuntimeEnvironmentResolveRequest,
): Promise<ResolvedProjectExecutionContext> {
  const params = querySchema.parse(input);
  return store.lock(params.environmentId, async () => {
    const record = await store.readEnvironment(params.environmentId);
    if (!record) throw new Error("stale-reference: runtime environment not found");
    if (
      identityKeyOf(record.scope) !== identityKeyOf(params) ||
      normalized(record.scope.workspacePath) !== normalized(params.workspacePath)
    )
      throw new Error("scope-mismatch: runtime environment scope differs");
    if (params.bindingId !== undefined && params.bindingId !== record.bindingId)
      throw new Error("scope-mismatch: runtime environment binding differs");
    if (params.expectedRevision !== undefined && params.expectedRevision !== record.currentRevision)
      throw new Error("stale-reference: runtime environment revision differs");
    if (
      params.expectedManifestDigest !== undefined &&
      params.expectedManifestDigest !== record.manifestDigest
    )
      throw new Error("stale-reference: runtime environment manifest differs");
    const cwd = params.cwd ?? params.workspacePath;
    if (!isAbsolute(cwd) || !contains(record.scope.workspacePath, cwd))
      throw new Error("scope-mismatch: execution cwd leaves the bound environment");
    return buildFrozenContext(store, record, record.scope, cwd);
  });
}

export async function queryFrozenContextForCwd(
  store: RuntimeEnvironmentStore,
  input: z.infer<typeof cwdQuerySchema>,
): Promise<ResolvedProjectExecutionContext | null> {
  const params = cwdQuerySchema.parse(input);
  const records = (await store.listEnvironments()).filter(
    (record) =>
      (record.scope.workspaceIdentity?.trim() || "") === (params.workspaceIdentity?.trim() || ""),
  );
  const record = matchEnvironmentForCwd(records, params.cwd);
  if (!record) return null;
  return queryFrozenContext(store, {
    ...record.scope,
    environmentId: record.environmentId,
    consumer: params.consumer,
    cwd: params.cwd,
  });
}

/** 只读上下文；环境事实和引用代际由各自 owner 在同一环境锁内裁决。 */
export async function buildFrozenContext(
  store: RuntimeEnvironmentStore,
  record: RuntimeEnvironmentRecord,
  executionScope: { workspacePath: string; workspaceIdentity?: string },
  cwd = executionScope.workspacePath,
): Promise<ResolvedProjectExecutionContext> {
  if (!isConsumableStatus(record.status) || record.status === "needsUpdate")
    throw new Error(
      `Runtime environment ${record.environmentId} is ${record.status}, not consumable`,
    );
  const manifest = await store.readManifest(record.environmentId, record.currentRevision);
  if (!manifest) throw new Error("stale-reference: frozen manifest is missing");
  const toolPaths: Record<string, string> = {};
  for (const tool of manifest.tools) if (tool.toolPath) toolPaths[tool.key] = tool.toolPath;
  const toolDirs = [...new Set(Object.values(toolPaths).map((path) => dirname(path)))];
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const delimiter = process.platform === "win32" ? ";" : ":";
  const inherited =
    Object.entries(process.env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  return {
    environmentId: record.environmentId,
    revision: record.currentRevision,
    manifestDigest: manifest.manifestDigest ?? manifest.declarationDigest,
    executionScope,
    cwd,
    toolPaths,
    envOverlay: {
      base: "inherit",
      set: {
        ...(toolDirs.length
          ? { [pathKey]: [...toolDirs, inherited].filter(Boolean).join(delimiter) }
          : {}),
        ...(manifest.resources
          ? {
              TEMP: manifest.resources.temp,
              TMP: manifest.resources.temp,
              TMPDIR: manifest.resources.temp,
              npm_config_cache: manifest.resources.cache,
              npm_config_store_dir: manifest.resources.packageStore,
              npm_config_package_import_method: "clone-or-copy",
              LCODE_DATA_BASE_DIR: manifest.resources.data,
              LCODE_RUNTIME_ENVIRONMENT_ID: record.environmentId,
            }
          : {}),
      },
      unset: [],
    },
    resourceLeaseToken: `lease-${randomUUID()}`,
  };
}
