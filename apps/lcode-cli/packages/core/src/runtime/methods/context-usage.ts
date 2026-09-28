import { modelMessageContentToText, traceContextToLogContext, estimateTokens } from "../deps.js";
import type { ModelInputMessage, ModelToolContract, TraceContext } from "../deps.js";
import type { ContextUsageBreakdownItem } from "@lcode/contracts";
import {
  measureUtf8Bytes,
  findLatestUserMessageFromEnd,
  stringifyForEstimation,
  parseMcpToolName,
  isMetaUserContextMessage,
} from "../helpers/index.js";
import {
  buildCategoryBreakdown,
  messageRoleContributor,
  sectionContributor,
  skillContributor,
  toolContributor,
  type ContextUsageCategoryBreakdown,
} from "../helpers/context-usage-breakdown.js";
import { compactContextUsageSnapshot } from "./context-usage-log-compact.js";
import type {
  ActiveTurnSteeringState,
  DrainedPendingInputDiagnostics,
  RunModelTextRequestOptions,
  ContextUsageConfidence,
  ContextUsageMetric,
  ContextUsageCategory,
  ContextUsageToolDetail,
  ContextUsageSkillDetail,
  ContextUsageMessageRoleBreakdown,
} from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";

type ContextUsageBreakdownSource = ContextUsageCategory["source"];

const CONTEXT_USAGE_BREAKDOWN_SOURCES = new Set<ContextUsageBreakdownSource>([
  "system_prompt",
  "meta_user_context",
  "skills",
  "tool_prompt",
  "system_tool_schemas",
  "mcp_tool_schemas",
  "messages",
]);

export function logContextUsageSnapshot(
  this: AgentRuntimeInternal,
  options: RunModelTextRequestOptions,
  snapshot: Record<string, unknown> = this.buildContextUsageSnapshot(options),
): void {
  this.logger?.debug("Context usage snapshot", {
    ...traceContextToLogContext(options.traceContext),
    event: "context_usage_snapshot",
    module: "core.runtime",
    status: "completed",
    ...compactContextUsageSnapshot(snapshot),
  });
}

export function logModelRequestSteeringContext(
  this: AgentRuntimeInternal,
  options: {
    activeTurn?: ActiveTurnSteeringState;
    drained?: DrainedPendingInputDiagnostics;
    messages: ModelInputMessage[];
    modelStepCount: number;
    traceContext: TraceContext;
  },
): void {
  if (!options.activeTurn && !options.drained) return;

  const drainedCount = options.drained?.pendingInputIds.length ?? 0;
  const drainedTail = drainedCount > 0 ? options.messages.slice(-drainedCount) : [];
  const drainedInputVisibleAtTail =
    drainedCount > 0 &&
    drainedTail.length === drainedCount &&
    drainedTail.every((message) => message.role === "user");
  const messageTail = this.buildModelMessageTailDiagnostics(options.messages);

  this.logger?.debug("Model request steering context", {
    ...traceContextToLogContext(options.traceContext),
    activeTurnId: options.activeTurn?.turnId,
    activeTurnKind: options.activeTurn?.kind,
    activeTurnQueueLength: options.activeTurn?.pendingInputs.length,
    activeTurnSteerable: options.activeTurn?.steerable,
    drainedInputCount: drainedCount,
    drainedInputVisibleAtTail,
    drainedPendingInputIds: options.drained?.pendingInputIds,
    event: "model.request.steering_context",
    injectedMessageIds: options.drained?.injectedMessageIds,
    latestUserMessageFromEnd: findLatestUserMessageFromEnd(options.messages),
    messageCount: options.messages.length,
    messageTail,
    messageTailRoles: messageTail.map((message) => message.role),
    modelStepCount: options.modelStepCount,
    module: "core.runtime",
    status: "completed",
  });
}

export function buildModelMessageTailDiagnostics(
  this: AgentRuntimeInternal,
  messages: ModelInputMessage[],
  limit = 8,
): Array<Record<string, unknown>> {
  const tail = messages.slice(-limit);
  const startIndex = messages.length - tail.length;
  return tail.map((message, index) => ({
    contentBytes: measureUtf8Bytes(modelMessageContentToText(message.content)),
    contentBlockCount: Array.isArray(message.content) ? message.content.length : undefined,
    hasToolCalls: (message.toolCalls?.length ?? 0) > 0,
    index: startIndex + index,
    role: message.role,
    toolCallCount: message.toolCalls?.length ?? 0,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
  }));
}

export function buildContextUsageSnapshot(
  this: AgentRuntimeInternal,
  options: RunModelTextRequestOptions,
): Record<string, unknown> {
  const contextSections = this.latestContextBuildResult?.sections ?? [];
  const systemPromptSections = contextSections.map((section) => ({
    name: section.name,
    source: section.source,
    injectionTarget: section.injectionTarget,
    cacheHint: section.cacheHint,
    ...this.estimatedMetricFromKnown(section.chars, section.tokens, "medium"),
  }));
  const systemSections = systemPromptSections.filter(
    (section) =>
      section.injectionTarget === "system" &&
      section.source !== "skills" &&
      section.source !== "tools",
  );
  const metaUserSections = systemPromptSections.filter(
    (section) => section.injectionTarget === "meta_user" && section.source !== "skills",
  );
  const skillSections = systemPromptSections.filter((section) => section.source === "skills");
  const toolPromptSections = systemPromptSections.filter((section) => section.source === "tools");
  const toolDetails = options.tools.map((tool) => this.buildToolUsageDetail(tool));
  const systemTools = toolDetails.filter((tool) => tool.source === "system_tool");
  const mcpTools = toolDetails.filter((tool) => tool.source === "mcp_tool");
  const skillDetails = this.buildSkillUsageDetails();
  const messageBreakdown = this.buildMessageRoleBreakdown(options.messages);
  const conversationMessageBreakdown = this.buildMessageRoleBreakdown(
    options.messages.filter(
      // 根因：新轮通知带 wrapper，但并未计入 ContextBuilder sections；按可信来源计回 Messages，避免漏算。
      (message, index) =>
        message.role !== "system" &&
        (!isMetaUserContextMessage(message) ||
          options.sourceEntries?.[index]?.metadata?.inputPresentation === "task_notification"),
    ),
  );
  const nonSystemMessageMetric = this.sumMetrics(conversationMessageBreakdown, "medium");

  const categories = [
    this.buildContextUsageCategory(
      "System prompt",
      "system_prompt",
      this.sumMetrics(systemSections, "medium"),
    ),
    this.buildContextUsageCategory(
      "Meta user context",
      "meta_user_context",
      this.sumMetrics(metaUserSections, "medium"),
    ),
    this.buildContextUsageCategory("Skills", "skills", this.sumMetrics(skillSections, "medium")),
    this.buildContextUsageCategory(
      "Tool prompt",
      "tool_prompt",
      this.sumMetrics(toolPromptSections, "medium"),
    ),
    this.buildContextUsageCategory(
      "System tool schemas",
      "system_tool_schemas",
      this.sumMetrics(systemTools, "low"),
    ),
    this.buildContextUsageCategory(
      "MCP tool schemas",
      "mcp_tool_schemas",
      this.sumMetrics(mcpTools, "low"),
    ),
    this.buildContextUsageCategory("Messages", "messages", nonSystemMessageMetric),
  ].filter((category) => category.tokens > 0);
  const totalTokens = categories.reduce((sum, category) => sum + category.tokens, 0);
  const totalChars = categories.reduce((sum, category) => sum + category.chars, 0);
  const categoriesWithPercent = categories.map((category) => ({
    ...category,
    percentTokens: totalTokens > 0 ? category.tokens / totalTokens : 0,
  }));
  const categoryBySource = new Map(
    categoriesWithPercent.map((category) => [category.source, category]),
  );
  const categoryBreakdown = [
    buildCategoryBreakdown(
      categoryBySource,
      "system_prompt",
      systemSections.map((section) => sectionContributor("system_prompt", section)),
    ),
    buildCategoryBreakdown(
      categoryBySource,
      "meta_user_context",
      metaUserSections.map((section) => sectionContributor("meta_user_context", section)),
    ),
    buildCategoryBreakdown(
      categoryBySource,
      "skills",
      skillDetails.map((skill) => skillContributor("skills", skill)),
    ),
    buildCategoryBreakdown(
      categoryBySource,
      "tool_prompt",
      toolPromptSections.map((section) => sectionContributor("tool_prompt", section)),
    ),
    buildCategoryBreakdown(
      categoryBySource,
      "system_tool_schemas",
      systemTools.map((tool) => toolContributor("system_tool_schemas", tool)),
    ),
    buildCategoryBreakdown(
      categoryBySource,
      "mcp_tool_schemas",
      mcpTools.map((tool) => toolContributor("mcp_tool_schemas", tool)),
    ),
    buildCategoryBreakdown(
      categoryBySource,
      "messages",
      conversationMessageBreakdown.map((message) => messageRoleContributor(message)),
    ),
  ].filter((breakdown): breakdown is ContextUsageCategoryBreakdown => breakdown !== undefined);

  return {
    tokenMethod: "estimated",
    confidence: "low",
    tokenizer: "lcode.estimateTokens.v1",
    totalChars,
    totalTokens,
    model: `${options.model.providerId}/${options.model.modelId}`,
    categories: categoriesWithPercent,
    categoryBreakdown,
    systemPromptSections,
    systemTools,
    mcpTools,
    skills: skillDetails,
    messageBreakdown,
    warnings: [
      "当前 token 来自本地估算，不是 provider count；tool schema 的真实 token 取决于 provider 序列化。",
      "Messages 分类不重复计算 system role 或 meta user context，因为它们已按 sections 单独统计。",
    ],
  };
}

export function buildContextUsageBreakdownFromSnapshot(
  snapshot: Record<string, unknown>,
): ContextUsageBreakdownItem[] {
  const categories = Array.isArray(snapshot.categories) ? snapshot.categories : [];
  const breakdown: ContextUsageBreakdownItem[] = [];

  for (const category of categories) {
    if (!isRecord(category)) {
      continue;
    }
    const source = contextUsageBreakdownSource(category.source);
    const chars = nonNegativeInteger(category.chars);
    if (!source || chars === undefined || chars <= 0) {
      continue;
    }
    breakdown.push({ source, chars });
  }

  return breakdown;
}

export function buildContextUsageCategory(
  this: AgentRuntimeInternal,
  name: ContextUsageCategory["name"],
  source: ContextUsageCategory["source"],
  metric: ContextUsageMetric,
): ContextUsageCategory {
  return {
    name,
    source,
    ...metric,
    percentTokens: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contextUsageBreakdownSource(value: unknown): ContextUsageBreakdownSource | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return CONTEXT_USAGE_BREAKDOWN_SOURCES.has(value as ContextUsageBreakdownSource)
    ? (value as ContextUsageBreakdownSource)
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.trunc(value);
}

export function buildToolUsageDetail(
  this: AgentRuntimeInternal,
  tool: ModelToolContract,
): ContextUsageToolDetail {
  const content = stringifyForEstimation({
    name: tool.name,
    description: tool.description,
    capability: tool.capability,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    readOnly: tool.readOnly,
    destructive: tool.destructive,
    sideEffectScope: tool.sideEffectScope,
    permission: tool.permission,
    resultBudget: tool.resultBudget,
  });
  const mcp = parseMcpToolName(tool.name);
  return {
    name: tool.name,
    source: mcp ? "mcp_tool" : "system_tool",
    serverName: mcp?.serverName,
    readOnly: tool.readOnly,
    sideEffectScope: tool.sideEffectScope,
    ...this.estimatedMetric(content, "low"),
  };
}

export function buildSkillUsageDetails(this: AgentRuntimeInternal): ContextUsageSkillDetail[] {
  return (this.skillLoadOutcome?.skills ?? []).map((skill) => {
    const content = [
      skill.name,
      skill.description,
      skill.whenToUse,
      skill.source,
      skill.scope,
      skill.path,
    ]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join("\n");
    return {
      name: skill.name,
      source: skill.source,
      scope: skill.scope,
      path: skill.path,
      ...this.estimatedMetric(content, "medium"),
    };
  });
}

export function buildMessageRoleBreakdown(
  this: AgentRuntimeInternal,
  messages: RunModelTextRequestOptions["messages"],
): ContextUsageMessageRoleBreakdown[] {
  const byRole = new Map<string, { chars: number; count: number; tokens: number }>();
  for (const message of messages) {
    const content = stringifyForEstimation({
      role: message.role,
      content: message.content,
      toolCalls: message.toolCalls,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
    });
    const current = byRole.get(message.role) ?? { chars: 0, count: 0, tokens: 0 };
    current.chars += content.length;
    current.count += 1;
    current.tokens += estimateTokens(content);
    byRole.set(message.role, current);
  }

  return [...byRole.entries()].map(([role, value]) => ({
    role,
    count: value.count,
    ...this.estimatedMetricFromKnown(value.chars, value.tokens, "medium"),
  }));
}

export function estimatedMetric(
  this: AgentRuntimeInternal,
  content: string,
  confidence: ContextUsageConfidence,
): ContextUsageMetric {
  return this.estimatedMetricFromKnown(content.length, estimateTokens(content), confidence);
}

export function estimatedMetricFromKnown(
  this: AgentRuntimeInternal,
  chars: number,
  tokens: number,
  confidence: ContextUsageConfidence,
): ContextUsageMetric {
  return {
    chars,
    tokens,
    tokenMethod: "estimated",
    confidence,
    tokenizer: "lcode.estimateTokens.v1",
  };
}

export function sumMetrics(
  this: AgentRuntimeInternal,
  values: Array<Pick<ContextUsageMetric, "chars" | "tokens">>,
  confidence: ContextUsageConfidence,
): ContextUsageMetric {
  return {
    chars: values.reduce((sum, value) => sum + value.chars, 0),
    tokens: values.reduce((sum, value) => sum + value.tokens, 0),
    tokenMethod: "estimated",
    confidence,
    tokenizer: "lcode.estimateTokens.v1",
  };
}
