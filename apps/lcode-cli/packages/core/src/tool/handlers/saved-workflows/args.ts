// ============================================================
// Saved workflows - 参数校验
// ============================================================
//
// 校验发生在**确认窗之前**：参数传错了没有任何值得用户裁决的东西，弹一个注定失败的窗只是
// 用一次无效决策打断模型自己的改错回路。这与 CreateWorkflow 对编不过的脚本的处理是同一条
// 原则（create-workflow.ts 的 `prepareApproval` 注释）。

import type { SavedWorkflowArgDeclaration, SavedWorkflowArgsDeclaration } from "@lcode/contracts";

export type WorkflowArgsValidation =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; errors: string[] };

/**
 * 把调用方传来的参数按声明校验并补齐默认值。
 *
 * 收集**全部**违规再一次性返回，而不是撞到第一条就退出：模型拿到「少了 pr，还多传了一个
 * prNumber」能一次改对，拿到「少了 pr」则会改一次、再撞一次。
 *
 * 未声明 args 的 workflow 收到任何参数都是错——它读不到它们，静默丢弃会让调用方以为参数
 * 生效了。
 */
export function validateWorkflowArgs(
  declaration: SavedWorkflowArgsDeclaration | undefined,
  provided: Record<string, unknown> | undefined,
): WorkflowArgsValidation {
  const declared = declaration ?? {};
  const given = provided ?? {};
  const errors: string[] = [];
  const args: Record<string, unknown> = {};

  const declaredNames = Object.keys(declared);
  for (const key of Object.keys(given)) {
    if (declared[key] !== undefined) continue;
    errors.push(
      declaredNames.length === 0
        ? `unknown argument '${key}': this workflow declares no arguments`
        : `unknown argument '${key}' (declared: ${declaredNames.join(", ")})`,
    );
  }

  for (const [key, spec] of Object.entries(declared)) {
    const supplied = given[key];
    // 缺省与显式 undefined 一视同仁：JSON 里传不出 undefined，所以两者只能是同一件事。
    if (supplied === undefined) {
      if (spec.default !== undefined) {
        // 默认值与传入值走**同一条**类型检查：一个声明成 number 却默认写成 "3" 的参数，
        // 错在保存的那一刻，不该等到脚本读到它才炸。
        const failure = typeMismatch(key, spec, spec.default, "default value");
        if (failure === undefined) args[key] = spec.default;
        else errors.push(failure);
        continue;
      }
      if (spec.required === true) errors.push(`missing required argument '${key}'`);
      continue;
    }

    const failure = typeMismatch(key, spec, supplied, "value");
    if (failure === undefined) args[key] = supplied;
    else errors.push(failure);
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, args };
}

/**
 * 类型不符时的说明，符合时 `undefined`。
 *
 * `json` 什么都收——它的意思正是"这里不做检查"，所以连 null 都是合法的 json 值。三个原语按
 * typeof 判定；`number` 额外拒 NaN 与 Infinity，因为它们没法经 JSON 过界到沙箱，放行只会把
 * 一个可读的错误挪到脚本里变成一个 `null`。
 */
function typeMismatch(
  key: string,
  spec: SavedWorkflowArgDeclaration,
  value: unknown,
  what: string,
): string | undefined {
  const describe = (expected: string): string =>
    `argument '${key}': expected ${expected}, got ${describeValue(value)} (${what})`;

  switch (spec.type) {
    case "string":
      return typeof value === "string" ? undefined : describe("a string");
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? undefined
        : describe("a finite number");
    case "boolean":
      return typeof value === "boolean" ? undefined : describe("a boolean");
    case "json":
      return undefined;
  }
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}
