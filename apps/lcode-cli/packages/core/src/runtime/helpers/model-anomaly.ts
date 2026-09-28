import type { ModelAnomalyGuardConfig, ModelToolCall, ToolCallId } from "../deps.js";

interface RepeatedToolCallWarningState {
  anomalyWarningsInjected: number;
  repeatedToolCallSignature?: string;
  repeatedToolCallStreakCount: number;
}

interface RepeatedToolCallWarningObservation {
  observedCount: number;
  threshold: number;
  toolCallId: ToolCallId;
  toolName: string;
  warningInjected: boolean;
}

interface ToolCallBudgetWarningObservation {
  observedCount: number;
  threshold: number;
  warningInjected: boolean;
}

export function detectRepeatedToolCallWarnings(
  toolCalls: readonly ModelToolCall[],
  state: RepeatedToolCallWarningState,
  config: Partial<ModelAnomalyGuardConfig> | undefined,
): RepeatedToolCallWarningObservation[] {
  const threshold = config?.repeatedToolCallWarningThreshold ?? 3;
  const maxBudgetWarningsPerTurn = config?.maxBudgetWarningsPerTurn ?? 3;
  if (threshold <= 0) return [];

  const observations: RepeatedToolCallWarningObservation[] = [];

  for (const toolCall of toolCalls) {
    const signature = buildRepeatedToolCallSignature(toolCall.name, toolCall.input);
    if (state.repeatedToolCallSignature === signature) {
      state.repeatedToolCallStreakCount += 1;
    } else {
      state.repeatedToolCallSignature = signature;
      state.repeatedToolCallStreakCount = 1;
    }

    if (state.repeatedToolCallStreakCount !== threshold) {
      continue;
    }

    const warningInjected = state.anomalyWarningsInjected < maxBudgetWarningsPerTurn;
    if (warningInjected) {
      state.anomalyWarningsInjected += 1;
    }

    observations.push({
      observedCount: state.repeatedToolCallStreakCount,
      threshold,
      toolCallId: toolCall.id as ToolCallId,
      toolName: toolCall.name,
      warningInjected,
    });
  }

  return observations;
}

export function detectToolCallBudgetWarning(
  currentToolCallCount: number,
  newToolCallCount: number,
  state: RepeatedToolCallWarningState,
  config: Partial<ModelAnomalyGuardConfig> | undefined,
): ToolCallBudgetWarningObservation | undefined {
  const threshold = config?.toolCallWarningThreshold;
  if (threshold === undefined || threshold <= 0) {
    return undefined;
  }

  const previousToolCallCount = currentToolCallCount - newToolCallCount;
  if (previousToolCallCount >= threshold || currentToolCallCount < threshold) {
    return undefined;
  }

  const maxBudgetWarningsPerTurn = config?.maxBudgetWarningsPerTurn ?? 3;
  const warningInjected = state.anomalyWarningsInjected < maxBudgetWarningsPerTurn;
  if (warningInjected) {
    state.anomalyWarningsInjected += 1;
  }

  return {
    observedCount: currentToolCallCount,
    threshold,
    warningInjected,
  };
}

export function buildRepeatedToolCallReminderBody(
  toolName: string,
  observedCount: number,
): string {
  return [
    `You have called ${toolName} with the same input ${observedCount} times in a row.`,
    "Do not repeat the exact same tool call again unless the user explicitly asked you to retry it unchanged.",
    "Use the existing result to take a different next step, explain the blocker, or ask the user for guidance.",
  ].join("\n");
}

export function buildToolCallBudgetReminderBody(observedCount: number): string {
  return [
    `This turn has already made ${observedCount} tool calls.`,
    "Do not keep calling tools reflexively. Use the gathered results to choose a different next step, summarize the blocker, or ask the user for guidance if you are stuck.",
  ].join("\n");
}

function buildRepeatedToolCallSignature(toolName: string, input: unknown): string {
  return `${JSON.stringify(toolName)}:${stableJson(input)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
