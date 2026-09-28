import type { WorkspaceHookReasonCode, WorkspaceHookReviewFlowState } from "@lcode/contracts";
import { workspaceHookReviewFlowStateSchema } from "@lcode/contracts";
import {
  workspaceHookReviewDecisionSchema,
  workspaceHookReviewRequestPayloadSchema,
  type WorkspaceHookReviewDecision,
  type WorkspaceHookReviewRequestPayload,
} from "@lcode/shared/lcode-protocol-v4";

export interface WorkspaceHookReviewTarget {
  sessionId: string;
  taskId: string;
  runId: string;
  remoteSessionId?: string;
  workspaceIdentity: string;
  bundleDigest: string;
  reviewFlowId: string;
  generation: number;
  interactionId: string;
}

export interface WorkspaceHookReviewOutcome {
  action: WorkspaceHookReviewDecision["action"] | "no_change";
  reviewItemIds: string[];
  reasonCode: WorkspaceHookReasonCode | undefined;
}

export type WorkspaceHookReviewResolveResult =
  | { accepted: true; reviewItemIds: string[] }
  | {
      accepted: false;
      reasonCode: "workspace_hooks_review_superseded" | "workspace_hooks_snapshot_mismatch";
    };

export interface WorkspaceHookReviewFlow {
  readonly request: WorkspaceHookReviewRequestPayload;
  readonly result: Promise<WorkspaceHookReviewOutcome>;
  readonly state: WorkspaceHookReviewFlowState;
}

interface MutableWorkspaceHookReviewFlow {
  request: WorkspaceHookReviewRequestPayload;
  result: Promise<WorkspaceHookReviewOutcome>;
  resolveResult: (outcome: WorkspaceHookReviewOutcome) => void;
  state: WorkspaceHookReviewFlowState;
  timer?: ReturnType<typeof setTimeout>;
  public: WorkspaceHookReviewFlow;
}

/** Runtime-owned review generation registry. It contains no persistence or UI behavior. */
export class WorkspaceHookReviewFlowRegistry {
  private readonly currentBySession = new Map<string, MutableWorkspaceHookReviewFlow>();

  open(value: WorkspaceHookReviewRequestPayload): WorkspaceHookReviewFlow {
    const request = workspaceHookReviewRequestPayloadSchema.parse(value);
    const current = this.currentBySession.get(request.sessionId);
    if (current && current.state.state === "pending") {
      if (sameGeneration(current.request, request)) return current.public;
      throw new Error("A pending Workspace Hook review must be superseded explicitly");
    }
    const flow = this.createFlow(request);
    this.currentBySession.set(request.sessionId, flow);
    return flow.public;
  }

  supersede(
    target: WorkspaceHookReviewTarget,
    replacement: WorkspaceHookReviewRequestPayload,
  ): WorkspaceHookReviewFlow {
    const current = this.currentBySession.get(target.sessionId);
    if (!current || !matchesGeneration(current.request, target)) {
      throw new Error("Cannot supersede an unknown Workspace Hook review generation");
    }
    const nextRequest = workspaceHookReviewRequestPayloadSchema.parse(replacement);
    if (
      nextRequest.sessionId !== current.request.sessionId ||
      nextRequest.reviewFlowId !== current.request.reviewFlowId ||
      nextRequest.generation <= current.request.generation
    ) {
      throw new Error("Replacement must advance the same Workspace Hook review flow");
    }
    this.settle(current, {
      state: "superseded",
      supersededByInteractionId: nextRequest.interactionId,
      outcome: {
        action: "no_change",
        reviewItemIds: [],
        reasonCode: "workspace_hooks_review_superseded",
      },
    });
    const next = this.createFlow(nextRequest);
    this.currentBySession.set(nextRequest.sessionId, next);
    return next.public;
  }

  validate(
    target: WorkspaceHookReviewTarget,
    decisionValue: WorkspaceHookReviewDecision,
  ): WorkspaceHookReviewResolveResult {
    const current = this.currentBySession.get(target.sessionId);
    if (!current) {
      return {
        accepted: false,
        reasonCode: "workspace_hooks_review_superseded",
      };
    }
    if (!matchesGeneration(current.request, target) || current.state.state !== "pending") {
      return {
        accepted: false,
        reasonCode: "workspace_hooks_review_superseded",
      };
    }
    if (!matchesSnapshot(current.request, target)) {
      return {
        accepted: false,
        reasonCode: "workspace_hooks_snapshot_mismatch",
      };
    }
    const decision = workspaceHookReviewDecisionSchema.parse(decisionValue);
    const reviewItemIds = resolveDecisionItemIds(current.request, decision);
    const knownItems = new Set(current.request.items.map((item) => item.reviewItemId));
    if (reviewItemIds.some((reviewItemId) => !knownItems.has(reviewItemId))) {
      return {
        accepted: false,
        reasonCode: "workspace_hooks_snapshot_mismatch",
      };
    }
    return { accepted: true, reviewItemIds };
  }

  resolve(
    target: WorkspaceHookReviewTarget,
    decisionValue: WorkspaceHookReviewDecision,
  ): WorkspaceHookReviewResolveResult {
    const validation = this.validate(target, decisionValue);
    if (!validation.accepted) return validation;
    const current = this.currentBySession.get(target.sessionId);
    if (!current) {
      return {
        accepted: false,
        reasonCode: "workspace_hooks_review_superseded",
      };
    }
    const decision = workspaceHookReviewDecisionSchema.parse(decisionValue);
    this.settle(current, {
      state: "resolved",
      outcome: {
        action: decision.action,
        reviewItemIds: validation.reviewItemIds,
        reasonCode: undefined,
      },
    });
    return validation;
  }

  fail(target: WorkspaceHookReviewTarget, reasonCode: WorkspaceHookReasonCode): boolean {
    const current = this.currentBySession.get(target.sessionId);
    if (
      !current ||
      current.state.state !== "pending" ||
      !matchesGeneration(current.request, target) ||
      !matchesSnapshot(current.request, target)
    ) {
      return false;
    }
    this.settle(current, {
      state: "cancelled",
      outcome: { action: "no_change", reviewItemIds: [], reasonCode },
    });
    return true;
  }

  closeWithoutDecision(target: WorkspaceHookReviewTarget): boolean {
    const current = this.currentBySession.get(target.sessionId);
    if (
      !current ||
      current.state.state !== "pending" ||
      !matchesGeneration(current.request, target) ||
      !matchesSnapshot(current.request, target)
    ) {
      return false;
    }
    this.settle(current, {
      state: "resolved",
      outcome: { action: "no_change", reviewItemIds: [], reasonCode: undefined },
    });
    return true;
  }

  getCurrentFlow(sessionId: string): WorkspaceHookReviewFlow | undefined {
    return this.currentBySession.get(sessionId)?.public;
  }

  getCurrent(sessionId: string): WorkspaceHookReviewFlowState | undefined {
    const state = this.currentBySession.get(sessionId)?.state;
    return state ? { ...state } : undefined;
  }

  private createFlow(request: WorkspaceHookReviewRequestPayload): MutableWorkspaceHookReviewFlow {
    let resolveResult!: (outcome: WorkspaceHookReviewOutcome) => void;
    const result = new Promise<WorkspaceHookReviewOutcome>((resolve) => {
      resolveResult = resolve;
    });
    const state = workspaceHookReviewFlowStateSchema.parse({
      reviewFlowId: request.reviewFlowId,
      generation: request.generation,
      interactionId: request.interactionId,
      sessionId: request.sessionId,
      workspaceIdentity: request.workspaceIdentity,
      bundleDigest: request.bundleDigest,
      state: "pending",
      createdAt: request.createdAt,
      deadlineAt: request.deadlineAt,
    });
    const flow = {} as MutableWorkspaceHookReviewFlow;
    const publicFlow: WorkspaceHookReviewFlow = {
      request,
      result,
      get state() {
        return { ...flow.state };
      },
    };
    Object.assign(flow, {
      request,
      result,
      resolveResult,
      state,
      public: publicFlow,
    });
    flow.timer = setTimeout(
      () => {
        if (flow.state.state !== "pending") return;
        this.settle(flow, {
          state: "timed_out",
          outcome: {
            action: "no_change",
            reviewItemIds: [],
            reasonCode: "workspace_hooks_interaction_timeout",
          },
        });
      },
      Math.max(0, request.deadlineAt - Date.now()),
    );
    flow.timer.unref?.();
    return flow;
  }

  private settle(
    flow: MutableWorkspaceHookReviewFlow,
    input: {
      state: "resolved" | "superseded" | "timed_out" | "cancelled";
      supersededByInteractionId?: string;
      outcome: WorkspaceHookReviewOutcome;
    },
  ): void {
    if (flow.state.state !== "pending") return;
    if (flow.timer) clearTimeout(flow.timer);
    flow.state = workspaceHookReviewFlowStateSchema.parse({
      ...flow.state,
      state: input.state,
      ...(input.supersededByInteractionId
        ? { supersededByInteractionId: input.supersededByInteractionId }
        : {}),
    });
    flow.resolveResult(input.outcome);
  }
}

function sameGeneration(
  left: WorkspaceHookReviewRequestPayload,
  right: WorkspaceHookReviewRequestPayload,
): boolean {
  return (
    left.reviewFlowId === right.reviewFlowId &&
    left.generation === right.generation &&
    left.interactionId === right.interactionId &&
    left.bundleDigest === right.bundleDigest
  );
}

function matchesSnapshot(
  request: WorkspaceHookReviewRequestPayload,
  target: WorkspaceHookReviewTarget,
): boolean {
  return (
    request.sessionId === target.sessionId &&
    request.taskId === target.taskId &&
    request.runId === target.runId &&
    request.remoteSessionId === target.remoteSessionId &&
    request.workspaceIdentity === target.workspaceIdentity &&
    request.bundleDigest === target.bundleDigest
  );
}

function matchesGeneration(
  request: WorkspaceHookReviewRequestPayload,
  target: WorkspaceHookReviewTarget,
): boolean {
  return (
    request.reviewFlowId === target.reviewFlowId &&
    request.generation === target.generation &&
    request.interactionId === target.interactionId
  );
}

function resolveDecisionItemIds(
  _request: WorkspaceHookReviewRequestPayload,
  decision: WorkspaceHookReviewDecision,
): string[] {
  return unique(decision.reviewItemIds);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
