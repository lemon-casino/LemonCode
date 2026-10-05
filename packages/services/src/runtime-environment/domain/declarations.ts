import { parse as parseToml } from "smol-toml";

/**
 * 工具声明静态解析与版本冻结（spec: specs/worktree-runtime-environments.md §6.1/§6.2）。
 * 只做静态解析，不执行任意表达式；冲突显式报错不猜测。
 * 纯函数：文件内容由 app 层读取后注入，便于测试与跨平台一致。
 */

export type DeclarationSource =
  | "mise.toml"
  | ".node-version"
  | ".nvmrc"
  | "package.json#packageManager"
  | "package.json#engines";

export interface DeclarationIssue {
  code: "configuration-conflict" | "unsupported-declaration";
  source: DeclarationSource;
  field?: string;
  message: string;
}

export interface ToolDeclaration {
  key: string;
  /** 规范化后的约束；exact=true 时即确切版本。 */
  constraint: string;
  exact: boolean;
  source: DeclarationSource;
}

export interface ProjectDeclarations {
  tools: ToolDeclaration[];
  packageManager?: { key: string; version: string; source: DeclarationSource };
  engines?: { key: string; constraint: string; source: DeclarationSource };
  lockfiles: { name: string; digest: string }[];
  /** 多包管理器锁且无法确定 manager 时为 true：不猜测、明确非冻结策略。 */
  ambiguousLocks: boolean;
  issues: DeclarationIssue[];
}

export interface DeclarationInputs {
  miseToml?: string;
  nodeVersionFile?: string;
  nvmrcFile?: string;
  packageJson?: string;
  /** 项目根发现的锁文件名集合（内容无关，指纹只按名字集合 + 文件摘要）。 */
  lockfileNames: string[];
  lockfileContents?: Record<string, string>;
}

export const KNOWN_LOCKFILES: readonly string[] = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
];

const EXACT_VERSION = /^v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/;

export function normalizeVersionText(raw: string): { constraint: string; exact: boolean } {
  const trimmed = raw.trim();
  const match = EXACT_VERSION.exec(trimmed);
  if (match?.[1]) return { constraint: match[1], exact: true };
  return { constraint: trimmed, exact: false };
}

function sha256(content: string): string {
  // # ponytail: FNV-1a 64 位指纹（domain 层禁 node:crypto；这只是声明指纹不是安全边界），
  // 碰撞风险仅影响"指纹相同但内容不同"的极端情况，升级判定还会比对 revision 记录本身。
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= BigInt(content.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function parseMiseTools(miseToml: string, issues: DeclarationIssue[]): ToolDeclaration[] {
  let parsed: unknown;
  try {
    parsed = parseToml(miseToml);
  } catch (error) {
    issues.push({
      code: "unsupported-declaration",
      source: "mise.toml",
      message: `mise.toml 不是合法 TOML：${error instanceof Error ? error.message : String(error)}`,
    });
    return [];
  }
  const tools = (parsed as { tools?: unknown } | null)?.tools;
  if (tools === undefined) return [];
  if (typeof tools !== "object" || tools === null || Array.isArray(tools)) {
    issues.push({
      code: "unsupported-declaration",
      source: "mise.toml",
      field: "tools",
      message: "tools 段必须是表",
    });
    return [];
  }
  const result: ToolDeclaration[] = [];
  for (const [key, value] of Object.entries(tools as Record<string, unknown>)) {
    if (typeof value !== "string") {
      // mise 支持表/数组等动态语法；静态解析不支持，明确上报不猜测。
      issues.push({
        code: "unsupported-declaration",
        source: "mise.toml",
        field: `tools.${key}`,
        message: "只支持字符串版本约束，不支持表/数组等动态语法",
      });
      continue;
    }
    const { constraint, exact } = normalizeVersionText(value);
    result.push({ key, constraint, exact, source: "mise.toml" });
  }
  return result;
}

function parseVersionFile(
  content: string,
  source: DeclarationSource,
  issues: DeclarationIssue[],
): ToolDeclaration | null {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (lines.length !== 1) {
    issues.push({
      code: "unsupported-declaration",
      source,
      message: lines.length === 0 ? "文件为空" : "只支持单行版本声明",
    });
    return null;
  }
  const { constraint, exact } = normalizeVersionText(lines[0] ?? "");
  return { key: "node", constraint, exact, source };
}

function parsePackageJson(
  packageJson: string,
  issues: DeclarationIssue[],
): {
  packageManager?: { key: string; version: string; source: DeclarationSource };
  engines?: { key: string; constraint: string; source: DeclarationSource };
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson);
  } catch (error) {
    issues.push({
      code: "unsupported-declaration",
      source: "package.json#packageManager",
      message: `package.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    });
    return {};
  }
  const record = parsed as { packageManager?: unknown; engines?: unknown };
  const result: ReturnType<typeof parsePackageJson> = {};
  if (typeof record.packageManager === "string") {
    // 形如 "pnpm@10.33.2+sha512..."；去掉校验和后按 key@version 解析。
    const withoutHash = record.packageManager.split("+")[0] ?? record.packageManager;
    const at = withoutHash.indexOf("@", 1);
    const normalized =
      at > 0 ? normalizeVersionText(withoutHash.slice(at + 1)) : { constraint: "", exact: false };
    if (at > 0 && normalized.exact) {
      result.packageManager = {
        key: withoutHash.slice(0, at),
        version: normalized.constraint,
        source: "package.json#packageManager",
      };
    } else {
      issues.push({
        code: "unsupported-declaration",
        source: "package.json#packageManager",
        field: "packageManager",
        message: `packageManager 必须是可解析的精确版本，收到 ${record.packageManager}`,
      });
    }
  }
  if (typeof record.engines === "object" && record.engines !== null) {
    const node = (record.engines as Record<string, unknown>).node;
    if (typeof node === "string" && node.trim().length > 0)
      result.engines = { key: "node", constraint: node.trim(), source: "package.json#engines" };
  }
  return result;
}

/**
 * 静态解析全部声明来源；冲突进 issues 不猜优先级。
 * 锁文件歧义（多 manager 锁且 packageManager 缺失）置 ambiguousLocks，由调用方走非冻结策略。
 */
export function parseProjectDeclarations(inputs: DeclarationInputs): ProjectDeclarations {
  const issues: DeclarationIssue[] = [];
  const tools: ToolDeclaration[] = [];
  if (inputs.miseToml !== undefined) tools.push(...parseMiseTools(inputs.miseToml, issues));
  if (inputs.nodeVersionFile !== undefined) {
    const node = parseVersionFile(inputs.nodeVersionFile, ".node-version", issues);
    if (node) tools.push(node);
  }
  if (inputs.nvmrcFile !== undefined) {
    const node = parseVersionFile(inputs.nvmrcFile, ".nvmrc", issues);
    if (node) tools.push(node);
  }
  const pkg =
    inputs.packageJson !== undefined
      ? parsePackageJson(inputs.packageJson, issues)
      : { packageManager: undefined, engines: undefined };

  // 同 key 约束冲突：双方都保留在 issues，选择 mise.toml 优先（显式工具表优先于单行文件）。
  const byKey = new Map<string, ToolDeclaration>();
  for (const tool of tools) {
    const existing = byKey.get(tool.key);
    if (!existing) {
      byKey.set(tool.key, tool);
      continue;
    }
    if (existing.constraint !== tool.constraint) {
      issues.push({
        code: "configuration-conflict",
        source: tool.source,
        field: tool.key,
        message: `${tool.key} 版本冲突：${existing.source} 说 ${existing.constraint}，${tool.source} 说 ${tool.constraint}`,
      });
      if (existing.source !== "mise.toml" && tool.source === "mise.toml") byKey.set(tool.key, tool);
    }
  }

  const knownLocks = inputs.lockfileNames.filter((name) => KNOWN_LOCKFILES.includes(name));
  const unknownLocks = inputs.lockfileNames.filter((name) => !KNOWN_LOCKFILES.includes(name));
  for (const name of unknownLocks)
    issues.push({
      code: "unsupported-declaration",
      source: "mise.toml",
      field: name,
      message: `未知锁文件 ${name}，不参与安装策略`,
    });
  const managersOnDisk = new Set<string>(
    knownLocks.map((name) => {
      if (name === "pnpm-lock.yaml") return "pnpm";
      if (name === "package-lock.json") return "npm";
      if (name === "yarn.lock") return "yarn";
      return "bun";
    }),
  );
  const ambiguousLocks = managersOnDisk.size > 1 && pkg.packageManager === undefined;
  if (ambiguousLocks)
    issues.push({
      code: "configuration-conflict",
      source: "package.json#packageManager",
      field: "lockfiles",
      message: `存在多个包管理器锁 ${[...managersOnDisk].join("/")} 且 package.json 未声明 packageManager，不得猜测`,
    });
  // packageManager 与磁盘锁不一致也上报（安装策略要展示双方）。
  if (pkg.packageManager && managersOnDisk.size === 1 && !managersOnDisk.has(pkg.packageManager.key))
    issues.push({
      code: "configuration-conflict",
      source: "package.json#packageManager",
      field: "packageManager",
      message: `packageManager 声明 ${pkg.packageManager.key}，但磁盘锁属于 ${[...managersOnDisk].join("/")}`,
    });

  // engines.node 存在但没有任何 Node 版本声明来源：确切版本无从选定，显式冲突（spec §6.1）。
  if (pkg.engines && ![...byKey.values()].some((tool) => tool.key === "node"))
    issues.push({
      code: "configuration-conflict",
      source: "package.json#engines",
      field: "engines.node",
      message: "engines.node 存在但没有 Node 版本声明来源（mise.toml/.node-version/.nvmrc）",
    });

  const lockfiles = knownLocks.map((name) => ({
    name,
    digest: sha256(inputs.lockfileContents?.[name] ?? name),
  }));
  return {
    tools: [...byKey.values()],
    ...(pkg.packageManager ? { packageManager: pkg.packageManager } : {}),
    ...(pkg.engines ? { engines: pkg.engines } : {}),
    lockfiles,
    ambiguousLocks,
    issues,
  };
}

/** 声明指纹：tools/manager/engines/锁摘要的稳定哈希；revision 升级判据（spec §6.2）。 */
export function digestDeclarations(declarations: ProjectDeclarations): string {
  return sha256(
    JSON.stringify({
      tools: declarations.tools,
      packageManager: declarations.packageManager ?? null,
      engines: declarations.engines ?? null,
      lockfiles: declarations.lockfiles,
      ambiguousLocks: declarations.ambiguousLocks,
    }),
  );
}

/**
 * engines 约束检查见 ./engines.ts（checkEnginesConstraint）；
 * 本文件只负责声明静态解析与指纹。
 */
