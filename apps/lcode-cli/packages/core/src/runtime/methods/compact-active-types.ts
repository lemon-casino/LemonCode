import type { CompactPhase, CompactReason, CompactTrigger } from "../deps.js";
import type { SessionEvent, TraceContext } from "../deps.js";
import type { selectCompactEntries } from "../helpers/index.js";
import type { CompactTimelineContext, RuntimeModelTextResult } from "../types.js";
import type { Model } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { type RuntimeMessageEntry } from "../../agent/message-history.js";

export interface CompactConversationAttempt {
  activeEntries: readonly RuntimeMessageEntry[];
  attempt: number;
  compactModel: Model;
  compactTools: ReturnType<AgentRuntimeInternal["getTools"]>;
  compactReason: CompactReason;
  compactTimeline: CompactTimelineContext;
  customInstructions: string | undefined;
  events: SessionEvent[];
  maxAttempts: number;
  options: NonNullable<Parameters<AgentRuntimeInternal["compactActiveConversation"]>[3]>;
  phase: CompactPhase;
  preCompactTokenCount: number;
  trigger: CompactTrigger;
  turnTraceContext: TraceContext;
  useMidConversationSystem: boolean;
}

export type CompactConversationSelection = ReturnType<typeof selectCompactEntries>;

export interface CompactSummaryAttemptResult {
  currentSelection: CompactConversationSelection;
  entriesToSummarize: RuntimeMessageEntry[];
  modelTraceContext: TraceContext;
  preservedEntries: RuntimeMessageEntry[];
  result: RuntimeModelTextResult;
}
