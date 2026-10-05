import type { DeclarationIssue, DeclarationSource } from "./declarations.js";

/**
 * engines 约束检查（spec §6.1：选中的确切版本必须满足支持的约束）。
 * # ponytail: 自写比较器只覆盖 精确/>=/<=/>/</=/^/~（允许缺省 minor/patch）与空格 AND 组合；
 * 出现 ||、通配符等未知语法时返回 unsupported issue 要求显式处理，不猜测。
 */

const EXACT_VERSION = /^v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/;

type PartVerdict = "satisfied" | "violated" | "unknown";

export function checkEnginesConstraint(
  toolVersion: string,
  engines: { key: string; constraint: string; source: DeclarationSource },
): DeclarationIssue | null {
  if (engines.constraint.includes("||"))
    return {
      code: "unsupported-declaration",
      source: engines.source,
      field: "engines.node",
      message: `不支持的 engines 语法（||）：${engines.constraint}`,
    };
  const parts = engines.constraint.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const version = parseVersionParts(toolVersion);
  if (!version)
    return {
      code: "unsupported-declaration",
      source: engines.source,
      field: "engines.node",
      message: `无法解析确切版本 ${toolVersion}`,
    };
  for (const part of parts) {
    const verdict = evaluatePart(version, part);
    if (verdict === "unknown")
      return {
        code: "unsupported-declaration",
        source: engines.source,
        field: "engines.node",
        message: `不支持的 engines 语法：${engines.constraint}`,
      };
    if (verdict === "violated")
      return {
        code: "configuration-conflict",
        source: engines.source,
        field: "engines.node",
        message: `选中的确切版本 ${toolVersion} 不满足 engines 约束 ${engines.constraint}`,
      };
  }
  return null;
}

function parseVersionParts(version: string): number[] | null {
  const core = version.split(/[-+]/)[0] ?? "";
  const parts = core.split(".").map((piece) => Number.parseInt(piece, 10));
  if (parts.length !== 3 || parts.some((piece) => !Number.isFinite(piece))) return null;
  return parts;
}

function evaluatePart(version: number[], spec: string): PartVerdict {
  const exact = EXACT_VERSION.exec(spec);
  if (exact?.[1]) {
    const target = parseVersionParts(exact[1]);
    if (!target) return "unknown";
    return version.every((piece, index) => piece === target[index]) ? "satisfied" : "violated";
  }
  const caret = /^\^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(spec);
  if (caret) {
    const major = Number(caret[1]);
    const minor = Number(caret[2] ?? 0);
    const patch = Number(caret[3] ?? 0);
    const ok =
      version[0] === major &&
      ((version[1] ?? 0) > minor || (version[1] === minor && (version[2] ?? 0) >= patch));
    return ok ? "satisfied" : "violated";
  }
  const tilde = /^~(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(spec);
  if (tilde) {
    const major = Number(tilde[1]);
    const minor = Number(tilde[2] ?? 0);
    const patch = Number(tilde[3] ?? 0);
    const ok = version[0] === major && version[1] === minor && (version[2] ?? 0) >= patch;
    return ok ? "satisfied" : "violated";
  }
  const compare = /^(>=|<=|>|<|=)v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(spec);
  if (compare) {
    const [, op, a, b, c] = compare;
    const target = [Number(a), Number(b ?? 0), Number(c ?? 0)];
    let cmp = 0;
    for (let index = 0; index < 3; index += 1) {
      const l = version[index] ?? 0;
      const r = target[index] ?? 0;
      if (l !== r) {
        cmp = l < r ? -1 : 1;
        break;
      }
    }
    if (op === ">=") return cmp >= 0 ? "satisfied" : "violated";
    if (op === "<=") return cmp <= 0 ? "satisfied" : "violated";
    if (op === ">") return cmp > 0 ? "satisfied" : "violated";
    if (op === "<") return cmp < 0 ? "satisfied" : "violated";
    return cmp === 0 ? "satisfied" : "violated";
  }
  return "unknown";
}
