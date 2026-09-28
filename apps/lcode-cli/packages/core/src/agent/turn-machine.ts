// ============================================================
// Turn Machine - State machine for turn lifecycle
// ============================================================

import type {
  TurnState,
  TurnPhase,
  ToolCall,
  ToolScheduleState,
  PermissionRequestState,
  PermissionDecision,
  TurnResultType,
  TurnErrorState,
  ModelRequestState,
} from "./turn-state.js";
import {
  TurnPhase as Phase,
  createTurnState,
  canTransitionTo,
  isTerminalPhase,
} from "./turn-state.js";
import type {
  ModelMessageContent,
  SessionId,
  TraceId,
  ToolCallId,
  TurnId,
} from "@lcode/contracts";
import type { PendingTurnInput } from "@lcode/contracts";
import {
  createTurnId,
  createCoreError,
  CoreErrorType,
  modelMessageContentToText,
} from "@lcode/contracts";

// -----------------------------------------------
// Turn Machine
// -----------------------------------------------

export interface TurnMachine {
  state: TurnState;
  start(): TurnState;
  startModelRequest(model: string, messages: ModelRequestState["messages"]): TurnState;
  receiveModelResponse(content: string): TurnState;
  addStreamingContent(content: string): TurnState;
  scheduleTools(toolCalls: ToolCall[], schedule: ToolScheduleState): TurnState;
  startToolExecution(): TurnState;
  completeTool(
    toolCallId: ToolCallId,
    result: { success: boolean; content: ModelMessageContent },
  ): TurnState;
  queuePendingInput(input: PendingTurnInput): TurnState;
  drainPendingInputs(): { inputs: PendingTurnInput[]; state: TurnState };
  requestPermission(request: PermissionRequestState): TurnState;
  resolvePermission(
    toolCallId: ToolCallId,
    decision: PermissionDecision,
    modifiedInput?: unknown,
  ): TurnState;
  aggregateResults(): TurnState;
  complete(response: string, resultType?: TurnResultType): TurnState;
  fail(error: TurnErrorState): TurnState;
  getNextPhase(): TurnPhase;
  isComplete(): boolean;
}

export class TurnMachineImpl implements TurnMachine {
  state: TurnState;

  constructor(state: TurnState) {
    this.state = state;
  }

  static create(
    sessionId: SessionId,
    turnNumber: number,
    input: string,
    traceId?: TraceId,
    turnId?: TurnId,
  ): TurnMachineImpl {
    const state = createTurnState(
      turnId ?? createTurnId(),
      sessionId,
      turnNumber,
      traceId ?? (crypto.randomUUID() as TraceId),
      input,
    );
    return new TurnMachineImpl(state);
  }

  private transition(phase: TurnPhase): TurnState {
    if (!canTransitionTo(this.state.phase, phase)) {
      throw createCoreError(
        CoreErrorType.InvalidTurnPhase,
        `Cannot transition from ${this.state.phase} to ${phase}`,
        {
          context: { current: this.state.phase, target: phase },
          recoverable: true,
        },
      );
    }
    return { ...this.state, phase };
  }

  start(): TurnState {
    return this.transition(Phase.ProcessingInput);
  }

  startModelRequest(model: string, messages: ModelRequestState["messages"]): TurnState {
    if (
      this.state.phase !== Phase.ProcessingInput &&
      this.state.phase !== Phase.AggregatingResults
    ) {
      throw createCoreError(
        CoreErrorType.InvalidTurnPhase,
        "Must be in ProcessingInput or AggregatingResults phase",
        {
          context: { current: this.state.phase },
          recoverable: true,
        },
      );
    }

    const state = this.transition(Phase.AwaitingModelResponse);
    return {
      ...state,
      modelRequest: {
        model,
        messages,
      },
    };
  }

  receiveModelResponse(content: string): TurnState {
    const state = this.transition(Phase.Streaming);
    return {
      ...state,
      streamingContent: state.streamingContent + content,
    };
  }

  addStreamingContent(content: string): TurnState {
    const state = this.transition(Phase.Streaming);
    return {
      ...state,
      streamingContent: state.streamingContent + content,
    };
  }

  scheduleTools(toolCalls: ToolCall[], schedule: ToolScheduleState): TurnState {
    const state = this.transition(Phase.SchedulingTools);
    return {
      ...state,
      toolCalls: toolCalls.map((tc) => ({
        id: tc.id as ToolCallId,
        name: tc.name,
        input: tc.input,
        status: "scheduled" as TurnState["toolCalls"][number]["status"],
        scheduledAt: new Date(),
      })),
      scheduledTools: schedule,
    };
  }

  startToolExecution(): TurnState {
    const needsPermission = this.state.toolCalls.some((tc) => tc.status === "waiting_permission");
    const nextPhase = needsPermission ? Phase.AwaitingPermission : Phase.ExecutingTools;

    const state = this.transition(nextPhase);
    return {
      ...state,
      toolCalls: state.toolCalls.map((tc) => ({
        ...tc,
        status:
          tc.status === "waiting_permission"
            ? tc.status
            : ("running" as TurnState["toolCalls"][number]["status"]),
        startedAt: tc.status !== "waiting_permission" ? new Date() : tc.startedAt,
      })),
    };
  }

  completeTool(
    toolCallId: ToolCallId,
    result: { success: boolean; content: ModelMessageContent },
  ): TurnState {
    const errorMessage = result.success ? undefined : modelMessageContentToText(result.content);
    const updatedToolCalls = this.state.toolCalls.map((tc) =>
      tc.id === toolCallId
        ? {
            ...tc,
            status: (result.success
              ? "completed"
              : "failed") as TurnState["toolCalls"][number]["status"],
            completedAt: new Date(),
            result: {
              success: result.success,
              content: result.content,
            },
          }
        : tc,
    );

    return {
      ...this.state,
      toolCalls: updatedToolCalls,
      toolResults: [
        ...this.state.toolResults,
        {
          success: result.success,
          content: result.content,
          error: result.success
            ? undefined
            : { type: "tool_error", message: errorMessage ?? "", recoverable: true },
        },
      ],
    };
  }

  queuePendingInput(input: PendingTurnInput): TurnState {
    return {
      ...this.state,
      pendingInputs: [...this.state.pendingInputs, input],
    };
  }

  drainPendingInputs(): { inputs: PendingTurnInput[]; state: TurnState } {
    return {
      inputs: this.state.pendingInputs,
      state: {
        ...this.state,
        pendingInputs: [],
      },
    };
  }

  requestPermission(request: PermissionRequestState): TurnState {
    const state = this.transition(Phase.AwaitingPermission);
    return {
      ...state,
      toolCalls: state.toolCalls.map((tc) =>
        tc.id === request.toolCallId
          ? { ...tc, status: "waiting_permission" as TurnState["toolCalls"][number]["status"] }
          : tc,
      ),
      pendingPermissions: [...state.pendingPermissions, request],
    };
  }

  resolvePermission(
    toolCallId: ToolCallId,
    decision: PermissionDecision,
    modifiedInput?: unknown,
  ): TurnState {
    const updatedToolCalls = this.state.toolCalls.map((tc) =>
      tc.id === toolCallId
        ? {
            ...tc,
            status:
              decision === "deny"
                ? ("permission_denied" as TurnState["toolCalls"][number]["status"])
                : tc.status,
            input: modifiedInput ?? tc.input,
          }
        : tc,
    );

    return {
      ...this.state,
      toolCalls: updatedToolCalls,
      pendingPermissions: this.state.pendingPermissions.filter((p) => p.toolCallId !== toolCallId),
      resolvedPermissions: [
        ...this.state.resolvedPermissions,
        {
          toolCallId,
          decision,
          modifiedInput,
          resolvedAt: new Date(),
        },
      ],
    };
  }

  aggregateResults(): TurnState {
    return this.transition(Phase.AggregatingResults);
  }

  complete(response: string, resultType: TurnResultType = "success"): TurnState {
    const state = this.transition(Phase.Completing);
    return {
      ...state,
      finalResponse: response,
      resultType,
      completedAt: new Date(),
    };
  }

  fail(error: TurnErrorState): TurnState {
    return {
      ...this.state,
      phase: Phase.Error,
      error,
      completedAt: new Date(),
    };
  }

  getNextPhase(): TurnPhase {
    const { phase, toolCalls, streamingContent } = this.state;

    if (phase === Phase.Streaming && toolCalls.length > 0) {
      return Phase.SchedulingTools;
    }

    if (phase === Phase.Streaming && toolCalls.length === 0 && streamingContent) {
      return Phase.Completing;
    }

    if (phase === Phase.ExecutingTools) {
      const pendingTools = toolCalls.filter(
        (tc) => tc.status === "running" || tc.status === "waiting_permission",
      );
      if (pendingTools.length === 0) {
        return Phase.AggregatingResults;
      }
    }

    if (phase === Phase.AggregatingResults) {
      const failedTools = toolCalls.filter(
        (tc) => tc.status === "failed" || tc.status === "permission_denied",
      );
      if (failedTools.length > 0) {
        return Phase.Completing;
      }
      return Phase.AwaitingModelResponse;
    }

    return phase;
  }

  isComplete(): boolean {
    return isTerminalPhase(this.state.phase);
  }
}
