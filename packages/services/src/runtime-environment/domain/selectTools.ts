import { satisfies, valid, validRange } from "semver";
import {
  LOCKFILE_MANAGERS,
  type DeclarationIssue,
  type DeclarationSource,
  type ProjectDeclarations,
  type ToolDeclaration,
} from "./declarations.js";
import { checkEnginesConstraint, intersectSemverRanges } from "./engines.js";

export interface SelectedTool {
  key: string;
  version: string;
  source: "project-declaration" | "app-default";
}
export interface ToolSelection {
  tools: SelectedTool[];
  issues: DeclarationIssue[];
  /** 不交给工具后端安装；依赖适配器必须验证冻结 Node 自带 npm 的实际版本，无锁也要验证。 */
  bundledNpmVersion?: string;
}
export interface ToolResolutionPlan extends ToolSelection {
  /** 每项已完成多来源交集，可直接传给 backend.resolveVersion；有 issues 时不得执行。 */
  requests: Array<{ key: "node" | "pnpm"; constraint: string }>;
}
type AppDefaults = ReadonlyArray<{ key: string; version: string }>;

function addIssue(
  issues: DeclarationIssue[],
  source: DeclarationSource,
  field: string,
  message: string,
  code: DeclarationIssue["code"] = "unsupported-declaration",
) {
  issues.push({ code, source, field, message });
}
function selectedManager(declarations: ProjectDeclarations, issues: DeclarationIssue[]): string {
  const manager = declarations.packageManager;
  if (manager) {
    if (!["npm", "pnpm"].includes(manager.key) || !valid(manager.version)) {
      addIssue(
        issues,
        manager.source,
        "packageManager",
        "packageManager 必须为受支持的 npm/pnpm 确切版本",
      );
    }
    return manager.key;
  }
  const managers = new Set(
    declarations.lockfiles.map(({ name }) => LOCKFILE_MANAGERS[name] ?? "unknown"),
  );
  if (managers.size > 1 || declarations.ambiguousLocks) {
    addIssue(
      issues,
      "package.json#packageManager",
      "lockfiles",
      "存在多个包管理器锁且未声明 packageManager",
      "configuration-conflict",
    );
  }
  const inferred = managers.values().next().value as string | undefined;
  if (inferred && !["npm", "pnpm"].includes(inferred)) {
    addIssue(issues, "package.json#packageManager", "lockfiles", "此包管理器尚未适配托管运行环境");
  }
  return inferred ?? "pnpm";
}
function constraintsFor(declarations: ProjectDeclarations, key: string): ToolDeclaration[] {
  const constraints = declarations.tools.filter((tool) => tool.key === key);
  if (key === "pnpm" && declarations.packageManager?.key === "pnpm") {
    constraints.push({
      key,
      constraint: declarations.packageManager.version,
      exact: true,
      source: declarations.packageManager.source,
    });
  }
  return constraints;
}
function validateSelected(
  declarations: ProjectDeclarations,
  key: string,
  version: string,
  constraints: ToolDeclaration[],
  issues: DeclarationIssue[],
) {
  for (const constraint of constraints) {
    if (!satisfies(version, constraint.constraint)) {
      addIssue(
        issues,
        constraint.source,
        key,
        `${version} 不满足 ${constraint.source} 中的 ${key} ${constraint.constraint}`,
        "configuration-conflict",
      );
    }
  }
  if (key === "node" && declarations.engines) {
    const error = checkEnginesConstraint(version, declarations.engines);
    if (error) issues.push(error);
  }
}
function collectTools(
  declarations: ProjectDeclarations,
  appDefaults: AppDefaults,
  resolvedVersions: Readonly<Record<string, string>> | undefined,
): ToolResolutionPlan {
  const issues = [...declarations.issues];
  const tools: SelectedTool[] = [];
  const requests: ToolResolutionPlan["requests"] = [];
  const manager = selectedManager(declarations, issues);
  const bundledNpmVersion =
    manager === "npm" && declarations.packageManager
      ? (valid(declarations.packageManager.version) ?? undefined)
      : undefined;
  const keys = new Set(["node", ...declarations.tools.map((tool) => tool.key)]);
  if (manager === "pnpm") keys.add("pnpm");
  for (const key of keys) {
    if (key !== "node" && key !== "pnpm") {
      addIssue(issues, "mise.toml", key, "此工具尚未适配");
      continue;
    }
    const constraints = constraintsFor(declarations, key);
    const source = constraints[0]?.source ?? "mise.toml";
    const invalid = constraints.find(
      (item) => !item.constraint.trim() || !validRange(item.constraint),
    );
    if (invalid) {
      addIssue(issues, invalid.source, key, "版本声明必须是支持的静态 semver 版本或范围");
      continue;
    }
    const exact = constraints.map((item) => valid(item.constraint)).find((value) => value !== null);
    // engines 只约束已选版本；没有工具声明时必须验证固定默认，不采纳 resolver 传来的其它版本。
    const fixed =
      exact ??
      (constraints.length ? undefined : appDefaults.find((tool) => tool.key === key)?.version);
    if (fixed !== undefined || constraints.length === 0) {
      const version = fixed ? valid(fixed) : null;
      if (!version) {
        addIssue(issues, source, key, `${key} 尚未解析成确切版本`);
        continue;
      }
      validateSelected(declarations, key, version, constraints, issues);
      tools.push({
        key,
        version,
        source: constraints.length ? "project-declaration" : "app-default",
      });
      continue;
    }
    const ranges = constraints.map((item) => item.constraint);
    if (key === "node" && declarations.engines) {
      if (!declarations.engines.constraint.trim() || !validRange(declarations.engines.constraint)) {
        addIssue(issues, declarations.engines.source, "engines.node", "无效的 semver engines 约束");
        continue;
      }
      ranges.push(declarations.engines.constraint);
    }
    let intersection: string | null;
    try {
      intersection = intersectSemverRanges(ranges);
    } catch {
      addIssue(issues, source, key, "版本范围超出支持的静态 semver 求解限制");
      continue;
    }
    if (intersection === null) {
      const sources = [
        ...constraints.map((item) => item.source),
        ...(key === "node" && declarations.engines ? [declarations.engines.source] : []),
      ];
      addIssue(
        issues,
        source,
        key,
        `${key} 在 ${[...new Set(sources)].join("、")} 中的范围无交集`,
        "configuration-conflict",
      );
      continue;
    }
    if (resolvedVersions === undefined) {
      requests.push({ key, constraint: intersection });
      continue;
    }
    const resolved = resolvedVersions[key];
    const version = resolved ? valid(resolved) : null;
    if (!version) {
      addIssue(issues, source, key, `${key} 尚未解析成确切版本`);
      continue;
    }
    // 后端只是候选版本来源，最终冻结仍逐一验证原始来源，不能把求解字符串当作验证收据。
    validateSelected(declarations, key, version, constraints, issues);
    tools.push({ key, version, source: "project-declaration" });
  }
  return { tools, requests, issues, ...(bundledNpmVersion ? { bundledNpmVersion } : {}) };
}

/** 纯函数：固定项直接选择，范围项只产出查询计划，app 才执行和持久化后端解析结果。 */
export function buildToolResolutionPlan(
  declarations: ProjectDeclarations,
  appDefaults: AppDefaults,
): ToolResolutionPlan {
  return collectTools(declarations, appDefaults, undefined);
}
export function selectToolsForFreeze(
  declarations: ProjectDeclarations,
  appDefaults: AppDefaults,
  options: { resolvedVersions?: Readonly<Record<string, string>> } = {},
): ToolSelection {
  const { tools, issues, bundledNpmVersion } = collectTools(
    declarations,
    appDefaults,
    options.resolvedVersions ?? {},
  );
  return { tools, issues, ...(bundledNpmVersion ? { bundledNpmVersion } : {}) };
}
