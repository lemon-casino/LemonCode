import { createHash, randomUUID } from "node:crypto";
import { beginGoalExecution, finishGoalExecution } from "@lcode/core";
import type { InstanceRef, WorldReadOp } from "@lcode/dynamic-workflow";
import type { AgentRuntimeWorkflowDriverDeps } from "./workflow-driver-types.js";
import { executeWorldRead } from "./workflow-world-read.js";
import { readWorldExecutionFacts } from "./workflow-world-execution-facts.js";

/** Called only on the driver's live path; journal replay never invokes this observer. */
export async function executeWorkflowWorldWithEvidence(
  deps: AgentRuntimeWorkflowDriverDeps,
  op: WorldReadOp,
  args: unknown[],
  execution: { runId: string; instance: InstanceRef } | undefined,
  execute: () => Promise<unknown> = () => executeWorldRead(deps, op, args),
): Promise<unknown> {
  if (op !== "run" || !execution || !deps.goalEvidenceOwner || typeof args[0] !== "string")
    return execute();
  let actorVersion: string | undefined;
  const capture = await beginGoalExecution(deps.goalEvidenceOwner, {
      source: "world.run",
      command: args[0],
      args:
        Array.isArray(args[1]) && args[1].every((item) => typeof item === "string") ? args[1] : [],
      executionId: `${execution.runId}/${execution.instance.siteId}/${execution.instance.ordinal}/${randomUUID()}`,
      startedAt: Date.now(),
    });
    // 统一验收必须等相关写入结算；仍在运行的 ask 不能被一条局部检查替代。
    if (capture) {
      const actors = actorEvidenceState(deps, execution.runId);
      actorVersion = actors.version;
      if (actors.unsettled)
        for (const requirement of capture.requirements) requirement.before = null;
    }
  let result: unknown;
  try {
    result = await execute();
  } catch (error) {
    if (capture) await finishQuietly(capture, null);
    throw error;
  }
  if (capture) {
    const actors = actorEvidenceState(deps, execution.runId);
    // command 执行期间仍可能启动新的 writer；只看执行前快照会将局部检查误记为最终集成通过。
    if (actors.unsettled || actors.version !== actorVersion)
      for (const requirement of capture.requirements) requirement.before = null;
    await finishQuietly(capture, result);
  }
  return result;
}

function actorEvidenceState(deps: AgentRuntimeWorkflowDriverDeps, runId: string) {
  const actors = deps.journal.listNodes(runId).filter((node) => node.kind === "ask");
  return {
    unsettled: actors.some((node) => node.status !== "completed" && node.status !== "failed"),
    version: JSON.stringify(
      actors
        .map((node) => [node.siteId, node.ordinal, node.inputHash, node.status])
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    ),
  };
}

async function finishQuietly(
  capture: NonNullable<Awaited<ReturnType<typeof beginGoalExecution>>>,
  result: unknown,
) {
  const facts = readWorldExecutionFacts(result);
  try {
    await finishGoalExecution(capture, {
      exitCode: facts?.exitCode ?? null,
      completedAt: Date.now(),
      output: facts?.output ?? {
        sha256: createHash("sha256").update("").digest("hex"),
        bytes: 0,
        truncated: false,
        artifactRefs: [],
      },
    });
  } catch {
    // 观察失败保留原执行结果；严格 Goal 因缺证据拒绝完成，而不是重跑已有副作用。
  }
}
