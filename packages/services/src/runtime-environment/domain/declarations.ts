import { parse as parseToml } from "smol-toml";
import { valid, validRange } from "semver";

export type DeclarationSource =
  | "mise.toml"
  | ".node-version"
  | ".nvmrc"
  | "package.json#packageManager"
  | "package.json#engines"
  | ".npmrc"
  | "pnpm-workspace.yaml";
export interface DeclarationIssue {
  code: "configuration-conflict" | "unsupported-declaration";
  source: DeclarationSource;
  field?: string;
  message: string;
}
export interface ToolDeclaration {
  key: string;
  constraint: string;
  exact: boolean;
  source: DeclarationSource;
}
export interface ProjectDeclarations {
  tools: ToolDeclaration[];
  packageManager?: { key: string; version: string; source: DeclarationSource };
  engines?: { key: string; constraint: string; source: DeclarationSource };
  lockfiles: { name: string; digest: string }[];
  ambiguousLocks: boolean;
  issues: DeclarationIssue[];
  configurationDigests?: Record<string, string>;
}
export interface DeclarationInputs {
  miseToml?: string;
  nodeVersionFile?: string;
  nvmrcFile?: string;
  packageJson?: string;
  lockfileNames: string[];
  lockfileDigests?: Readonly<Record<string, string>>;
  configurationDigests?: Readonly<Record<string, string>>;
}
export const LOCKFILE_MANAGERS: Readonly<Record<string, string>> = {
  "pnpm-lock.yaml": "pnpm",
  "package-lock.json": "npm",
  "yarn.lock": "yarn",
  "bun.lock": "bun",
  "bun.lockb": "bun",
};
export const KNOWN_LOCKFILES: readonly string[] = Object.keys(LOCKFILE_MANAGERS);
export const CONFIGURATION_FILES = [".npmrc", "pnpm-workspace.yaml"] as const;
export const isSha256Digest = (value: string | undefined): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

export function normalizeVersionText(raw: string): { constraint: string; exact: boolean } {
  const constraint = raw.trim().replace(/^v(?=\d)/u, "");
  const exactVersion = valid(constraint);
  return { constraint: exactVersion ?? constraint, exact: exactVersion !== null };
}
function issue(
  issues: DeclarationIssue[],
  source: DeclarationSource,
  field: string,
  message: string,
  code: DeclarationIssue["code"] = "unsupported-declaration",
) {
  issues.push({ code, source, field, message });
}
function version(
  value: unknown,
  key: string,
  source: DeclarationSource,
  issues: DeclarationIssue[],
): ToolDeclaration | undefined {
  if (typeof value !== "string" || !value.trim() || !validRange(value.trim())) {
    const field =
      source === "mise.toml"
        ? `tools.${key}`
        : source === "package.json#engines"
          ? `engines.${key}`
          : key;
    issue(issues, source, field, "版本声明必须是支持的静态 semver 版本或范围");
    return;
  }
  return { key, source, ...normalizeVersionText(value) };
}
function versionFile(content: string, source: DeclarationSource, issues: DeclarationIssue[]) {
  const lines = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (lines.length !== 1) {
    issue(issues, source, "node", lines.length ? "只支持单行版本声明" : "文件为空");
    return;
  }
  return version(lines[0], "node", source, issues);
}
function packageDeclaration(content: string, issues: DeclarationIssue[]) {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    issue(issues, "package.json#packageManager", "package.json", "package.json 不是合法 JSON");
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issue(issues, "package.json#packageManager", "package.json", "package.json 必须是对象");
    return {};
  }
  const pkg = value as Record<string, unknown>;
  const result: Pick<ProjectDeclarations, "packageManager" | "engines"> = {};
  if (pkg.packageManager !== undefined) {
    const match =
      typeof pkg.packageManager === "string"
        ? /^(npm|pnpm)@([^+]+)(?:\+sha(?:224|256|384|512)\.[a-f\d]+)?$/u.exec(pkg.packageManager)
        : null;
    const exactVersion = match ? valid(match[2]) : null;
    if (!match || !exactVersion) {
      issue(
        issues,
        "package.json#packageManager",
        "packageManager",
        "packageManager 必须为受支持的 npm/pnpm 确切版本",
      );
    } else {
      result.packageManager = {
        key: match[1]!,
        version: exactVersion,
        source: "package.json#packageManager",
      };
    }
  }
  if (pkg.engines !== undefined) {
    if (!pkg.engines || typeof pkg.engines !== "object" || Array.isArray(pkg.engines)) {
      issue(issues, "package.json#engines", "engines", "engines 必须是对象");
    } else {
      const node = (pkg.engines as Record<string, unknown>).node;
      if (node !== undefined) {
        const parsed = version(node, "node", "package.json#engines", issues);
        if (parsed)
          result.engines = { key: "node", constraint: parsed.constraint, source: parsed.source };
      }
    }
  }
  return result;
}

export function parseProjectDeclarations(inputs: DeclarationInputs): ProjectDeclarations {
  const issues: DeclarationIssue[] = [];
  const tools: ToolDeclaration[] = [];
  if (inputs.miseToml !== undefined) {
    try {
      const config = parseToml(inputs.miseToml);
      if (
        config.tools !== undefined &&
        (!config.tools || typeof config.tools !== "object" || Array.isArray(config.tools))
      ) {
        issue(issues, "mise.toml", "tools", "tools 段必须是表");
      } else if (config.tools) {
        for (const [key, value] of Object.entries(config.tools)) {
          if (!["node", "pnpm"].includes(key)) {
            issue(issues, "mise.toml", `tools.${key}`, "首期只支持受控 Node/pnpm 后端");
            continue;
          }
          const parsed = version(value, key, "mise.toml", issues);
          if (parsed) tools.push(parsed);
        }
      }
    } catch {
      issue(issues, "mise.toml", "tools", "mise.toml 不是合法 TOML");
    }
  }
  for (const [content, source] of [
    [inputs.nodeVersionFile, ".node-version"],
    [inputs.nvmrcFile, ".nvmrc"],
  ] as const) {
    if (content === undefined) continue;
    const parsed = versionFile(content, source, issues);
    if (parsed) tools.push(parsed);
  }
  const pkg =
    inputs.packageJson === undefined ? {} : packageDeclaration(inputs.packageJson, issues);
  const known = [
    ...new Set(inputs.lockfileNames.filter((name) => KNOWN_LOCKFILES.includes(name))),
  ].sort();
  for (const name of inputs.lockfileNames) {
    if (!KNOWN_LOCKFILES.includes(name))
      issue(issues, "package.json#packageManager", name, `未知锁文件 ${name}`);
  }
  const managers = new Set(known.map((name) => LOCKFILE_MANAGERS[name]!));
  const ambiguousLocks = managers.size > 1 && !pkg.packageManager;
  if (ambiguousLocks)
    issue(
      issues,
      "package.json#packageManager",
      "lockfiles",
      "存在多个包管理器锁且未声明 packageManager",
      "configuration-conflict",
    );
  if (pkg.packageManager && managers.size && !managers.has(pkg.packageManager.key)) {
    issue(
      issues,
      "package.json#packageManager",
      "lockfiles",
      `packageManager ${pkg.packageManager.key} 与锁文件 ${known.join(", ")} 不一致`,
      "configuration-conflict",
    );
  }
  if ([...managers].some((manager) => !["pnpm", "npm"].includes(manager)) && !pkg.packageManager) {
    issue(issues, "package.json#packageManager", "lockfiles", "此包管理器尚未适配托管运行环境");
  }
  // 显式 manager 是安装策略的唯一选择；无关锁不得污染其内容摘要或触发另一 manager 安装。
  const selectedLocks = pkg.packageManager
    ? known.filter((name) => LOCKFILE_MANAGERS[name] === pkg.packageManager!.key)
    : known;
  const lockfiles = selectedLocks.map((name) => {
    const digest = inputs.lockfileDigests?.[name];
    if (!isSha256Digest(digest))
      issue(issues, "package.json#packageManager", name, `锁文件 ${name} 缺少真实内容 SHA-256`);
    return { name, digest: isSha256Digest(digest) ? digest : "missing" };
  });
  const configurationDigests: Record<string, string> = {};
  for (const name of CONFIGURATION_FILES) {
    const digest = inputs.configurationDigests?.[name];
    if (digest === undefined) continue;
    // 配置可含凭据；只接受内容摘要，不能把调用方误传的原文带入诊断或持久化。
    if (isSha256Digest(digest)) configurationDigests[name] = digest;
    else issue(issues, name, name, "配置缺少真实内容 SHA-256");
  }
  for (const key of ["node", "pnpm"]) {
    const exact = tools.filter((tool) => tool.key === key && tool.exact);
    if (new Set(exact.map((tool) => tool.constraint)).size > 1) {
      issue(
        issues,
        exact[1]!.source,
        key,
        `${key} 的精确版本声明冲突：${exact.map((tool) => `${tool.source} ${tool.constraint}`).join("；")}`,
        "configuration-conflict",
      );
    }
  }
  const declaredPnpm = tools.find((tool) => tool.key === "pnpm" && tool.exact);
  if (
    pkg.packageManager?.key === "pnpm" &&
    declaredPnpm &&
    declaredPnpm.constraint !== pkg.packageManager.version
  ) {
    issue(
      issues,
      "package.json#packageManager",
      "pnpm",
      "package.json#packageManager 与 mise.toml tools.pnpm 版本冲突",
      "configuration-conflict",
    );
  }
  return {
    tools,
    ...pkg,
    lockfiles,
    ambiguousLocks,
    issues,
    ...(inputs.configurationDigests ? { configurationDigests } : {}),
  };
}

/** 只返回规范序列化；app 对结果计算 SHA-256，domain 不伪装为哈希或依赖 Node crypto。 */
export function serializeDeclarations(declarations: ProjectDeclarations): string {
  const canonical = <T>(values: T[]) =>
    values.sort((a, b) => {
      const left = JSON.stringify(a);
      const right = JSON.stringify(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  const manager = declarations.packageManager;
  const engines = declarations.engines;
  return JSON.stringify({
    tools: canonical(
      declarations.tools.map(({ key, constraint, exact, source }) => ({
        key,
        constraint,
        exact,
        source,
      })),
    ),
    packageManager: manager
      ? { key: manager.key, version: manager.version, source: manager.source }
      : null,
    engines: engines
      ? { key: engines.key, constraint: engines.constraint, source: engines.source }
      : null,
    lockfiles: canonical(
      declarations.lockfiles
        .filter(({ name }) => !manager || LOCKFILE_MANAGERS[name] === manager.key)
        .map(({ name, digest }) => ({ name, digest: isSha256Digest(digest) ? digest : "missing" })),
    ),
    configurationDigests: Object.fromEntries(
      CONFIGURATION_FILES.flatMap((name) => {
        const digest = declarations.configurationDigests?.[name];
        return isSha256Digest(digest) ? [[name, digest]] : [];
      }),
    ),
    ambiguousLocks: declarations.ambiguousLocks,
  });
}
