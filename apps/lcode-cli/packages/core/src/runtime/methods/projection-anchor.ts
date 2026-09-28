import type {
  MessageAnchorOrigin,
  MessageProjectionAnchor,
  SyntheticUserMessageSource,
  TraceContext,
} from "../deps.js";

// ── v4 transcript 锚点（清单）──
// additive JSON：旧数据无 anchor，读侧宽容降级；turnId 取值现成（traceContext）。
// sourceCommandId 在 v4 command inbox 接线后随命令执行上下文写入。
export function buildProjectionAnchor(
  traceContext: TraceContext,
  origin?: MessageAnchorOrigin,
  sourceCommandId?: string,
): MessageProjectionAnchor | undefined {
  if (traceContext.turnId === undefined && origin === undefined && sourceCommandId === undefined) {
    return undefined;
  }
  return {
    ...(traceContext.turnId ? { turnId: traceContext.turnId } : {}),
    ...(origin ? { origin } : {}),
    ...(sourceCommandId ? { sourceCommandId } : {}),
  };
}

// 旧 SyntheticUserMessageSource → v4 userInput.origin 词表的只读映射。
export function mapSyntheticSourceToAnchorOrigin(
  source: SyntheticUserMessageSource,
): MessageAnchorOrigin {
  switch (source) {
    case "background_task":
    case "subagent":
      return "backgroundResult";
    case "goal-continuation":
      return "goalContinuation";
    default:
      return "synthetic";
  }
}
