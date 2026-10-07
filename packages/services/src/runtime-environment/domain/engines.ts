import { Range, minVersion, satisfies, valid, validRange, type Comparator } from "semver";
import type { DeclarationIssue, DeclarationSource } from "./declarations.js";

export function checkEnginesConstraint(
  toolVersion: string,
  engines: { key: string; constraint: string; source: DeclarationSource },
): DeclarationIssue | null {
  if (!valid(toolVersion) || !engines.constraint.trim() || !validRange(engines.constraint)) {
    return {
      code: "unsupported-declaration",
      source: engines.source,
      field: "engines.node",
      message: "无效的 semver 版本或 engines 约束",
    };
  }
  return satisfies(toolVersion, engines.constraint)
    ? null
    : {
        code: "configuration-conflict",
        source: engines.source,
        field: "engines.node",
        message: `${toolVersion} 不满足 engines.node ${engines.constraint}`,
      };
}

const MAX_INTERSECTION_BRANCHES = 4096;
function prereleaseTuple(comparator: Comparator): string | undefined {
  if (!comparator.value || !comparator.semver.prerelease.length) return;
  const { major, minor, patch } = comparator.semver;
  return `${major}.${minor}.${patch}`;
}
function combineBranches(left: readonly Comparator[], right: readonly Comparator[]): string | null {
  const permitted = new Set(left.map(prereleaseTuple).filter((tuple) => tuple !== undefined));
  const rightTuples = new Set(right.map(prereleaseTuple));
  for (const tuple of permitted) if (!rightTuples.has(tuple)) permitted.delete(tuple);
  const values: string[] = [];
  for (const comparator of [...left, ...right]) {
    const tuple = prereleaseTuple(comparator);
    if (!tuple || permitted.has(tuple)) {
      values.push(comparator.value);
      continue;
    }
    // 简单拼接会把某一来源允许的预发布扩散给其它来源；只有双方都允许的 tuple 才能保留。
    // 不允许的预发布下界提升到稳定版，上界去掉预发布标记，semver 默认规则继续排除预发布。
    if (!comparator.operator) return null;
    values.push(`${comparator.operator.startsWith(">") ? ">=" : "<"}${tuple}`);
  }
  const range = new Range([...new Set(values.filter(Boolean))].sort().join(" ") || "*");
  return minVersion(range) ? range.range || "*" : null;
}

/** 每个来源内部是 OR，来源之间是 AND；空交集返回 null，过大的求解拒绝而非猜测。 */
export function intersectSemverRanges(constraints: readonly string[]): string | null {
  if (!constraints.length) return "*";
  let branches = new Range(constraints[0]!).set;
  for (const constraint of constraints.slice(1)) {
    const next = new Range(constraint).set;
    if (branches.length * next.length > MAX_INTERSECTION_BRANCHES) {
      throw new RangeError("semver range intersection exceeds the supported branch limit");
    }
    // semver 的 Range.set 返回只读分支；这里只缓存和遍历，不应承诺可变 Comparator 数组。
    const intersections = new Map<string, readonly Comparator[]>();
    for (const left of branches) {
      for (const right of next) {
        const intersection = combineBranches(left, right);
        if (intersection !== null) intersections.set(intersection, new Range(intersection).set[0]!);
      }
    }
    branches = [...intersections.values()];
    if (!branches.length) return null;
  }
  if (branches.length > MAX_INTERSECTION_BRANCHES) {
    throw new RangeError("semver range intersection exceeds the supported branch limit");
  }
  const satisfiable = branches
    .map(
      (branch) =>
        branch
          .map((part) => part.value)
          .filter(Boolean)
          .join(" ") || "*",
    )
    .filter((constraint) => minVersion(constraint) !== null);
  return [...new Set(satisfiable)].sort().join(" || ") || null;
}
