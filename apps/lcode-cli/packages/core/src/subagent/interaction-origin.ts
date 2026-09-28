import type {
  InteractionRequestOrigin,
  SessionId,
  ToolCallId,
  TurnId,
} from "@lcode/contracts";

export interface SubagentInteractionOriginContext {
  agentId: string;
  agentType: string;
  childSessionId: SessionId;
  description: string;
  parentSessionId: SessionId;
  parentToolCallId?: ToolCallId | string;
  parentTurnId?: TurnId;
}

export function buildSubagentInteractionOrigin(
  context: SubagentInteractionOriginContext,
  childTurnId?: TurnId,
): InteractionRequestOrigin {
  return {
    kind: "subagent",
    agentId: context.agentId,
    agentType: context.agentType,
    childSessionId: context.childSessionId,
    ...(childTurnId ? { childTurnId } : {}),
    description: context.description,
    parentSessionId: context.parentSessionId,
    ...(context.parentToolCallId ? { parentToolCallId: context.parentToolCallId } : {}),
    ...(context.parentTurnId ? { parentTurnId: context.parentTurnId } : {}),
  };
}
