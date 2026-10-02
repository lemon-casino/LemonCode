// PermissionService remains the sole owner of session permission grants.
import {
  AMEND_WORKFLOW_TOOL_NAME,
  type PermissionRuleset,
  type PermissionUpdate,
  type RiskLevel,
} from "@lcode/contracts";
import { resolvePlanModeTransitionPermission } from "./plan-mode-policy.js";
import { isPreapprovedWorkflowDraftWrite } from "./workflow-draft-path.js";
import { applyPermissionUpdates } from "../tool/executor/permission-rules.js";
import type { ToolPermissionRulePolicy } from "../tool/types.js";
import {
  defaultPermissionConfig,
  type PermissionBehavior,
  type PermissionConfig,
  type PermissionContext,
  type PermissionDecisionResult,
  type PermissionToolCapability,
  type ResolvedPermissionCapability,
} from "./service-types.js";
import { matchesProjectRules, isPreapprovedWebFetchRequest } from "./project-rules.js";
import { getRiskLevel, resolveCapability } from "./capability.js";

export { defaultPermissionConfig } from "./service-types.js";
export type {
  PermissionBehavior,
  PermissionConfig,
  PermissionContext,
  PermissionDecisionResult,
  PermissionToolCapability,
} from "./service-types.js";

/** 草稿免确认的规则号。 */
const WORKFLOW_DRAFT_PREAPPROVED_RULE_ID = "tool.workflowDraft.preapproved";

export class PermissionService {
  /**
   * 会话级 allow 规则（「Always allow in this session」）。
   * 一个实例 = 一个 app = 一个会话，所以"随会话消亡"不需要任何额外机制：重启 / 冷恢复 / `/new`
   * 都会造一个空的新实例。只服务 alwaysAsk gate（见 checkAlwaysAsk），普通工具的模式语义不认它。
   */
  private sessionRules: PermissionRuleset = { version: 1 };

  constructor(private config: PermissionConfig = defaultPermissionConfig) {}

  grantSessionPermission(updates: PermissionUpdate[]): void {
    this.sessionRules = applyPermissionUpdates(this.sessionRules, updates);
  }

  checkPermission(
    context: PermissionContext,
    toolCapability?: PermissionToolCapability,
    projectRules?: PermissionRuleset | null,
    rulePolicy?: ToolPermissionRulePolicy,
  ): PermissionDecisionResult {
    const capability = resolveCapability(context, toolCapability, (name, capability) =>
      this.getRiskLevel(name, capability),
    );
    const planModeTransition = resolvePlanModeTransitionPermission(context);

    if (planModeTransition) {
      return planModeTransition.behavior === "allow"
        ? this.allow(context, capability, planModeTransition.ruleId, planModeTransition.reason)
        : this.deny(context, capability, planModeTransition.ruleId, planModeTransition.reason);
    }

    if (capability.requiresUserInteraction) {
      if (this.config.disallowedTools.has(context.toolName)) {
        return this.deny(
          context,
          capability,
          "rule.disallowedTools",
          `Tool ${context.toolName} is explicitly disallowed`,
        );
      }

      return this.ask(
        context,
        capability,
        "tool.userInteraction",
        `Tool ${context.toolName} requires user interaction`,
      );
    }

    // 声明 alwaysAsk 的工具必须经过用户确认，不能被权限模式的放行分支绕过。
    if (capability.alwaysAsk) {
      return this.checkAlwaysAsk(context, capability, projectRules, rulePolicy);
    }

    const planEnabled = context.planEnabled ?? context.mode === "plan";
    if (context.mode === "yolo" && !planEnabled) {
      return this.allow(context, capability, "mode.yolo", "Yolo mode bypasses permission prompts");
    }

    if (context.mode === "auto") {
      return this.deny(
        context,
        capability,
        "mode.auto.unimplemented",
        "Auto mode is reserved but not implemented yet",
      );
    }

    if (this.config.disallowedTools.has(context.toolName)) {
      return this.deny(
        context,
        capability,
        "rule.disallowedTools",
        `Tool ${context.toolName} is explicitly disallowed`,
      );
    }

    if (matchesProjectRules(projectRules, "deny", context, capability, rulePolicy)) {
      return this.deny(
        context,
        capability,
        "rule.project.deny",
        `Tool ${context.toolName} is denied by project permission rules`,
      );
    }

    if (matchesProjectRules(projectRules, "ask", context, capability, rulePolicy)) {
      return this.ask(
        context,
        capability,
        "rule.project.ask",
        `Tool ${context.toolName} requires approval by project permission rules`,
      );
    }

    if (planEnabled) {
      return this.checkPlanMode(context, capability);
    }

    if (matchesProjectRules(projectRules, "allow", context, capability, rulePolicy)) {
      return this.allow(
        context,
        capability,
        "rule.project.allow",
        `Tool ${context.toolName} is allowed by project permission rules`,
      );
    }

    if (isPreapprovedWebFetchRequest(context)) {
      return this.allow(
        context,
        capability,
        "tool.webfetch.preapproved",
        "WebFetch URL is preapproved",
      );
    }

    // workflow 草稿免确认：
    // 与 WebFetch 预批同一位次——排在 plan 分支之后，因为 plan 模式必须继续拦下一切写入，
    // 草稿也是写入；也排在项目 deny / ask 之后，项目规则照样压得过它。判定本身见
    // workflow-draft-path.ts（含"为什么这样放行是安全的"）。
    if (
      isPreapprovedWorkflowDraftWrite({
        input: context.input,
        toolName: context.toolName,
        workingDirectory: context.workingDirectory,
      })
    ) {
      return this.allow(
        context,
        capability,
        WORKFLOW_DRAFT_PREAPPROVED_RULE_ID,
        "Workflow draft file is preapproved",
      );
    }

    if (this.config.allowedTools.has(context.toolName)) {
      return this.allow(
        context,
        capability,
        "rule.allowedTools",
        `Tool ${context.toolName} is explicitly allowed`,
      );
    }

    if (context.mode === "edit") {
      return this.checkEditMode(context, capability);
    }

    return this.checkBuildMode(context, capability);
  }

  /**
   * 工具自报 alwaysAsk 时的判定：ask 压过所有"放行"分支（yolo 直通、plan 的 readOnly 直通），
   * 但**压不过"阻断"**——所以这里先自己走一遍硬阻断判定。
   *
   * 为什么不直接返回 ask：disallowedTools 是用户配置的硬禁用，项目 deny 规则符合工具自报的
   * denyPriority: "beforeAsk"，auto 模式是"该模式未实现"的保护。少了这一步，一个被硬禁用的
   * 工具会退化成"弹个窗、用户一点就能跑"。
   *
   * 这些判定在 checkPermission 里按原有顺序还会各自出现一次；此处刻意只覆盖 alwaysAsk 工具，
   * 不改动其他工具的既有优先级（尤其 yolo 目前先于 disallowedTools 放行这一点）。
   */
  private checkAlwaysAsk(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    projectRules?: PermissionRuleset | null,
    rulePolicy?: ToolPermissionRulePolicy,
  ): PermissionDecisionResult {
    if (context.mode === "auto") {
      return this.deny(
        context,
        capability,
        "mode.auto.unimplemented",
        "Auto mode is reserved but not implemented yet",
      );
    }
    if (this.config.disallowedTools.has(context.toolName)) {
      return this.deny(
        context,
        capability,
        "rule.disallowedTools",
        `Tool ${context.toolName} is explicitly disallowed`,
      );
    }
    if (matchesProjectRules(projectRules, "deny", context, capability, rulePolicy)) {
      return this.deny(
        context,
        capability,
        "rule.project.deny",
        `Tool ${context.toolName} is denied by project permission rules`,
      );
    }
    // 会话免确认：阻断分支之后、ask 之前。命中即放行，不发 permission 事件、不弹窗；
    // 与 gate 本身一样不看模式（yolo / plan / build 一致）。
    if (
      capability.approvalSource !== "user" &&
      matchesProjectRules(this.sessionRules, "allow", context, capability, rulePolicy)
    ) {
      return this.allow(
        context,
        capability,
        "rule.session.allow",
        `Tool ${context.toolName} was allowed for this session`,
      );
    }
    // 修订免确认：AmendWorkflow 的前驱是
    // **本会话发起**的 run、且不是用户亲手停下的，即放行。与会话规则同位——阻断分支之后、ask 之前，
    // 不看模式。事实来自 resolveInput 回填的 `predecessor`（journal 的 parent_session_id / stopReason），
    // 不是内存表：重启、冷恢复后依然成立，也没有可播种、可撤销的东西。别的会话的 run、用户停过的
    // run 照常 ask：钥匙是 run 的归属，不是字段的在场。
    if (this.isOwnedWorkflowAmend(context)) {
      return this.allow(
        context,
        capability,
        "rule.session.workflowOwner",
        `Tool ${context.toolName} amends a run this session started`,
      );
    }
    return this.ask(
      context,
      capability,
      "tool.alwaysAsk",
      capability.approvalSource === "user" && capability.permissionReason
        ? capability.permissionReason
        : `Tool ${context.toolName} always requires explicit approval`,
    );
  }

  /** AmendWorkflow 且回填的 `predecessor` 说「本会话的 run、非用户停下」。 */
  private isOwnedWorkflowAmend(context: PermissionContext): boolean {
    if (context.toolName !== AMEND_WORKFLOW_TOOL_NAME) return false;
    if (!context.input || typeof context.input !== "object") return false;
    const predecessor = (context.input as Record<string, unknown>).predecessor;
    if (!predecessor || typeof predecessor !== "object") return false;
    const facts = predecessor as Record<string, unknown>;
    return facts.owned_by_this_session === true && facts.stop_reason !== "user";
  }

  private checkPlanMode(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
  ): PermissionDecisionResult {
    if (capability.readOnly && !capability.destructive) {
      return this.allow(
        context,
        capability,
        "mode.plan.readOnly",
        "Plan mode allows read-only tool execution",
      );
    }

    if (this.isMcpToolCapability(capability) && !capability.destructive) {
      return this.allow(
        context,
        capability,
        "mode.plan.mcp",
        "Plan mode allows non-destructive MCP tool execution",
      );
    }

    if (
      capability.allowedInPlanMode &&
      capability.sideEffectScope === "session" &&
      !capability.destructive &&
      !capability.needsApproval
    ) {
      return this.allow(
        context,
        capability,
        "mode.plan.explicitSessionCapability",
        "Plan mode allows this explicit non-destructive session control action",
      );
    }

    return this.deny(
      context,
      capability,
      "mode.plan.nonReadOnly",
      "Plan mode only allows read-only, non-destructive tools",
    );
  }

  private isMcpToolCapability(capability: ResolvedPermissionCapability): boolean {
    return capability.permissionName === "mcp";
  }

  private checkBuildMode(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
  ): PermissionDecisionResult {
    if (capability.readOnly && !capability.destructive && !capability.needsApproval) {
      return this.allow(
        context,
        capability,
        "mode.build.readOnly",
        "Build mode allows read-only tools",
      );
    }

    if (capability.riskLevel === "critical") {
      return this.ask(
        context,
        capability,
        "mode.build.criticalRisk",
        "Critical risk tools require explicit approval",
      );
    }

    if (capability.riskLevel === "high" && !this.config.autoApproveHighRisk) {
      return this.ask(
        context,
        capability,
        "mode.build.highRisk",
        "High risk tools require explicit approval",
      );
    }

    if (
      capability.sideEffectScope === "session" &&
      capability.riskLevel === "low" &&
      !capability.destructive &&
      !capability.needsApproval
    ) {
      return this.allow(
        context,
        capability,
        "mode.build.sessionState",
        "Build mode allows low-risk session-local state updates",
      );
    }

    if (
      capability.needsApproval ||
      capability.destructive ||
      capability.sideEffectScope !== "none"
    ) {
      return this.ask(
        context,
        capability,
        "mode.build.sideEffect",
        "Tool has side effects and requires approval",
      );
    }

    return this.allow(
      context,
      capability,
      "mode.build.lowRisk",
      "Build mode allows low-risk tool execution",
    );
  }

  private checkEditMode(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
  ): PermissionDecisionResult {
    if (capability.permissionName === "edit" && capability.sideEffectScope === "workspace") {
      return this.allow(
        context,
        capability,
        "mode.edit.fileEdit",
        "Edit mode allows file edit tools",
      );
    }

    return this.checkBuildMode(context, capability);
  }

  requiresApproval(context: PermissionContext, toolCapability?: PermissionToolCapability): boolean {
    const decision = this.checkPermission(context, toolCapability);
    return decision.decision === "ask";
  }

  getRiskLevel(toolName: string, toolCapability?: PermissionToolCapability): RiskLevel {
    return getRiskLevel(toolName, toolCapability);
  }

  private allow(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    ruleId: string,
    reason?: string,
  ): PermissionDecisionResult {
    return this.result("allow", context, capability, ruleId, reason);
  }

  private ask(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    ruleId: string,
    reason: string,
  ): PermissionDecisionResult {
    return this.result("ask", context, capability, ruleId, reason);
  }

  private deny(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    ruleId: string,
    reason: string,
  ): PermissionDecisionResult {
    return this.result("deny", context, capability, ruleId, reason);
  }

  private result(
    decision: PermissionBehavior,
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    ruleId: string,
    reason?: string,
  ): PermissionDecisionResult {
    return {
      decision,
      allowed: decision === "allow",
      escalated: decision === "ask",
      mode: context.mode,
      reason,
      riskLevel: capability.riskLevel,
      ruleId,
      sideEffectScope: capability.sideEffectScope,
      ...(capability.alwaysAsk ? { alwaysAsk: true } : {}),
      ...(capability.approvalSource ? { approvalSource: capability.approvalSource } : {}),
    };
  }
}
