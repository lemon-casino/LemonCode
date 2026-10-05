import type { RuntimeEnvironmentStatus } from "@lcode/shared";

/**
 * 环境状态机（spec: specs/worktree-runtime-environments.md §10.1）。
 * 纯转换函数：非法迁移返回原状态并产生诊断，不静默跳变；
 * failed→resolvingTools 仅经显式重试，cancelled 是结算态不复活。
 */

const FORWARD: Readonly<Record<string, RuntimeEnvironmentStatus>> = {
  allocated: "resolvingTools",
  resolvingTools: "installingTools",
  installingTools: "preparingDependencies",
  preparingDependencies: "ready",
  ready: "needsUpdate",
  needsUpdate: "resolvingTools",
};

/** 准备阶段的窄联合（operation.stage 域）；releasing/releaseBlocked/released 属于释放流程。 */
export type PreparationStage = Exclude<
  RuntimeEnvironmentStatus,
  "releasing" | "releaseBlocked" | "released"
>;

export function advanceStatus(
  current: RuntimeEnvironmentStatus,
  event: "step" | "ready" | "fail" | "cancel-requested" | "cancelled",
): { status: PreparationStage; invalid?: boolean };
export function advanceStatus(
  current: RuntimeEnvironmentStatus,
  event: "release" | "release-blocked" | "released",
): { status: RuntimeEnvironmentStatus; invalid?: boolean };
export function advanceStatus(
  current: RuntimeEnvironmentStatus,
  event:
    | "step"
    | "ready"
    | "fail"
    | "cancel-requested"
    | "cancelled"
    | "release"
    | "release-blocked"
    | "released",
): { status: RuntimeEnvironmentStatus; invalid?: boolean } {
  if (event === "cancel-requested") {
    // 已在取消/释放流程中的状态不回跳；结算态不复活。
    if (current === "cancelling" || current === "cancelled") return { status: current };
    if (TERMINAL_LIKE.has(current)) return { status: current, invalid: true };
    return { status: "cancelling" };
  }
  if (event === "cancelled") {
    if (current !== "cancelling") return { status: current, invalid: true };
    return { status: "cancelled" };
  }
  if (event === "fail") {
    if (TERMINAL_LIKE.has(current)) return { status: current, invalid: true };
    if (current === "cancelling") return { status: current, invalid: true };
    return { status: "failed" };
  }
  if (event === "ready") {
    if (current !== "preparingDependencies" && current !== "needsUpdate")
      return { status: current, invalid: true };
    return { status: "ready" };
  }
  if (event === "step") {
    const next = FORWARD[current];
    if (!next) return { status: current, invalid: true };
    return { status: next };
  }
  if (event === "release") {
    if (RELEASE_INPUT.has(current)) return { status: "releasing" };
    return { status: current, invalid: true };
  }
  if (event === "release-blocked") {
    if (current !== "releasing") return { status: current, invalid: true };
    return { status: "releaseBlocked" };
  }
  // released
  if (current !== "releasing" && current !== "releaseBlocked")
    return { status: current, invalid: true };
  return { status: "released" };
}

/** 这些状态下不能再发起取消：事实已结算（spec §10.3 取消结算持久化、不复活）。 */
const TERMINAL_LIKE: ReadonlySet<RuntimeEnvironmentStatus> = new Set([
  "ready",
  "failed",
  "cancelled",
  "released",
]);

const RELEASE_INPUT: ReadonlySet<RuntimeEnvironmentStatus> = new Set([
  "allocated",
  "resolvingTools",
  "installingTools",
  "preparingDependencies",
  "ready",
  "needsUpdate",
  "failed",
  "cancelled",
  "releasing",
  "releaseBlocked",
]);

/** 准备阶段是否仍可被 fence 拒绝新消费者（spec §7 fence 规则）。 */
export function isBusyStatus(status: RuntimeEnvironmentStatus): boolean {
  return (
    status === "allocated" ||
    status === "resolvingTools" ||
    status === "installingTools" ||
    status === "preparingDependencies" ||
    status === "cancelling" ||
    status === "releasing"
  );
}

export function isConsumableStatus(status: RuntimeEnvironmentStatus): boolean {
  return status === "ready" || status === "needsUpdate";
}
