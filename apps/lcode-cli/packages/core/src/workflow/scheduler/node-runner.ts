import {
  createChildTraceContext,
  type WorkflowGraphNode,
  type WorkflowNodeStatus,
} from "@lcode/contracts";
import { WorkflowSchedulerEventLog } from "./events.js";
import { addArtifact, compactWorkflowPayload, updateGraphNode, upsertActivity } from "./graph.js";
import { buildDefaultNodePrompt, safeArtifactName } from "./prompts.js";
import type {
  NodeRunStarted,
  WorkflowGraphSchedulerDeps,
  WorkflowGraphSchedulerRunOptions,
  WorkflowGraphSchedulerSnapshotAccess,
  WorkflowSchedulerNodePromise,
} from "./types.js";

export interface WorkflowNodeRunnerRuntime {
  createActivityId: () => string;
  eventLog: WorkflowSchedulerEventLog;
  runner: WorkflowGraphSchedulerDeps["runner"];
  writeArtifact: WorkflowGraphSchedulerDeps["writeArtifact"];
  writeSnapshot: WorkflowGraphSchedulerDeps["writeSnapshot"];
}

export function runWorkflowNode(
  snapshotAccess: WorkflowGraphSchedulerSnapshotAccess,
  node: WorkflowGraphNode,
  options: WorkflowGraphSchedulerRunOptions,
  maxAttempts: number,
  runtime: WorkflowNodeRunnerRuntime,
): WorkflowSchedulerNodePromise {
  let resolveStarted: (value: NodeRunStarted) => void = () => {};
  const started = new Promise<NodeRunStarted>((resolve) => {
    resolveStarted = resolve;
  });
  const promise = (async () => {
    const initialSnapshot = snapshotAccess.getSnapshot();
    const activityId = runtime.createActivityId();
    const startedAt = runtime.eventLog.timestamp();
    const inputArtifactPaths = initialSnapshot.artifacts.map((artifact) => artifact.path);
    const traceContext = options.traceContext
      ? createChildTraceContext(options.traceContext, {
          attributes: {
            workflowActivityId: activityId,
            workflowKind: initialSnapshot.kind,
            workflowNodeId: node.id,
            workflowPhase: options.phase,
            workflowRunId: initialSnapshot.runId,
          },
          sessionId: options.traceContext.sessionId,
        })
      : undefined;
    const activeSnapshot = upsertActivity(
      updateGraphNode(initialSnapshot, node.id, {
        error: undefined,
        status: "active",
      }),
      {
        activityId,
        inputArtifactPaths,
        kind: "agent_session",
        nodeId: node.id,
        outputArtifactPaths: [],
        parentSessionId: options.parentSessionId,
        phase: options.phase,
        startedAt,
        status: "active",
        traceId: traceContext?.traceId,
      },
      runtime.eventLog.timestamp(),
    );
    await runtime.writeSnapshot(activeSnapshot, { signal: options.abortSignal });
    snapshotAccess.setSnapshot(activeSnapshot);
    await runtime.eventLog.appendGraphStatus(
      activeSnapshot,
      node.id,
      options.phase,
      "active",
      options.abortSignal,
    );
    await runtime.eventLog.emitEvent(activeSnapshot, "node_started", {
      message: `Node started: ${node.title}`,
      nodeId: node.id,
      phase: options.phase,
      signal: options.abortSignal,
    });
    resolveStarted({ snapshot: activeSnapshot });

    try {
      const result = await runtime.runner.run({
        abortSignal: options.abortSignal,
        activityId,
        cwd: options.cwd,
        node,
        onChildSessionStarted: async (event) => {
          const latestSnapshot = snapshotAccess.getSnapshot();
          const currentActivity = latestSnapshot.activities.find(
            (activity) => activity.activityId === activityId,
          );
          if (!currentActivity || currentActivity.status !== "active") return;
          const childStartedSnapshot = upsertActivity(
            latestSnapshot,
            {
              ...currentActivity,
              ...(event.model ? { model: event.model } : {}),
              sessionId: event.sessionId,
              traceId: event.traceId ?? currentActivity.traceId,
              turnId: event.turnId ?? currentActivity.turnId,
            },
            runtime.eventLog.timestamp(),
          );
          await runtime.writeSnapshot(childStartedSnapshot, { signal: options.abortSignal });
          snapshotAccess.setSnapshot(childStartedSnapshot);
          await runtime.eventLog.emitEvent(childStartedSnapshot, "workflow_session_linked", {
            message: `Workflow session linked: ${event.sessionId}`,
            nodeId: node.id,
            payload: compactWorkflowPayload({
              activityId,
              model: event.model,
              sessionId: event.sessionId,
              traceId: event.traceId,
              turnId: event.turnId,
            }),
            phase: options.phase,
            signal: options.abortSignal,
          });
        },
        onEvent: options.onEvent,
        parentSessionId: options.parentSessionId,
        phase: options.phase,
        prompt: options.buildPrompt
          ? options.buildPrompt({ node, phase: options.phase, snapshot: activeSnapshot })
          : buildDefaultNodePrompt(activeSnapshot, node, options.phase),
        runId: activeSnapshot.runId,
        task: activeSnapshot.task,
        traceContext,
      });
      const artifact = await runtime.writeArtifact(
        activeSnapshot.runId,
        `${options.artifactDirectory ?? "artifacts/exec"}/${safeArtifactName(node.id)}.md`,
        result.response,
        { signal: options.abortSignal },
      );
      const latestSnapshot = snapshotAccess.getSnapshot();
      const completedSnapshot = addArtifact(
        upsertActivity(
          updateGraphNode(latestSnapshot, node.id, {
            attempts: node.attempts,
            error: undefined,
            status: "completed",
          }),
          {
            activityId,
            artifactPath: artifact.relativePath,
            completedAt: runtime.eventLog.timestamp(),
            inputArtifactPaths,
            kind: "agent_session",
            nodeId: node.id,
            outputArtifactPaths: [artifact.relativePath],
            parentSessionId: options.parentSessionId,
            phase: options.phase,
            ...(result.model ? { model: result.model } : {}),
            sessionId: result.sessionId,
            startedAt,
            status: "completed",
            traceId: result.traceId ?? traceContext?.traceId,
            turnId: result.turnId,
          },
          runtime.eventLog.timestamp(),
        ),
        {
          contentType: "text/markdown",
          createdAt: runtime.eventLog.timestamp(),
          label: node.title,
          path: artifact.relativePath,
          phase: options.phase,
        },
        runtime.eventLog.timestamp(),
      );
      await runtime.writeSnapshot(completedSnapshot, { signal: options.abortSignal });
      snapshotAccess.setSnapshot(completedSnapshot);
      await runtime.eventLog.appendGraphStatus(
        completedSnapshot,
        node.id,
        options.phase,
        "completed",
        options.abortSignal,
      );
      await runtime.eventLog.emitEvent(completedSnapshot, "artifact_written", {
        message: `Artifact written: ${artifact.relativePath}`,
        nodeId: node.id,
        phase: options.phase,
        signal: options.abortSignal,
      });
      await runtime.eventLog.emitEvent(completedSnapshot, "node_completed", {
        message: `Node completed: ${node.title}`,
        nodeId: node.id,
        phase: options.phase,
        signal: options.abortSignal,
      });
      return { nodeId: node.id, ok: true, snapshot: completedSnapshot };
    } catch (error) {
      if (options.abortSignal?.aborted) {
        throw error;
      }
      const attempts = (node.attempts ?? 0) + 1;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const nextStatus: WorkflowNodeStatus = attempts >= maxAttempts ? "failed" : "pending";
      const latestSnapshot = snapshotAccess.getSnapshot();
      const currentActivity = latestSnapshot.activities.find(
        (activity) => activity.activityId === activityId,
      );
      const failedSnapshot = upsertActivity(
        updateGraphNode(latestSnapshot, node.id, {
          attempts,
          error: errorMessage,
          status: nextStatus,
        }),
        {
          activityId,
          completedAt: runtime.eventLog.timestamp(),
          error: errorMessage,
          inputArtifactPaths,
          kind: "agent_session",
          ...(currentActivity?.model ? { model: currentActivity.model } : {}),
          nodeId: node.id,
          outputArtifactPaths: [],
          parentSessionId: options.parentSessionId,
          phase: options.phase,
          ...(currentActivity?.sessionId ? { sessionId: currentActivity.sessionId } : {}),
          startedAt,
          status: nextStatus,
          traceId: currentActivity?.traceId ?? traceContext?.traceId,
          ...(currentActivity?.turnId ? { turnId: currentActivity.turnId } : {}),
        },
        runtime.eventLog.timestamp(),
      );
      await runtime.writeSnapshot(failedSnapshot, { signal: options.abortSignal });
      snapshotAccess.setSnapshot(failedSnapshot);
      await runtime.eventLog.appendGraphStatus(
        failedSnapshot,
        node.id,
        options.phase,
        nextStatus,
        options.abortSignal,
      );
      await runtime.eventLog.emitEvent(failedSnapshot, "node_failed", {
        message: errorMessage,
        nodeId: node.id,
        payload: { attempts, retry: nextStatus === "pending" },
        phase: options.phase,
        signal: options.abortSignal,
      });
      return { nodeId: node.id, ok: false, snapshot: failedSnapshot };
    }
  })() as WorkflowSchedulerNodePromise;
  promise.started = started;
  return promise;
}
