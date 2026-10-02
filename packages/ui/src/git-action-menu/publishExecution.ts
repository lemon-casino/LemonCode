import type { IGitService } from "@lcode/services";
import type { GitCommitResult, GitPublishState } from "@lcode/shared";
import { getErrorMessage } from "../lib/errorMessage.js";
import { samePublishState, type PublishPlan } from "./publishModel.js";

export interface PublishOutcome {
  id: string;
  kind: "commit" | "branch" | "create-tag" | "tag";
  status: "pending" | "running" | "success" | "failed" | "skipped";
  target: string;
  remote?: string;
  commitHash?: string;
  tagCreated?: boolean;
  message?: string;
}
export interface PublishRun {
  plan: PublishPlan;
  state: GitPublishState;
  outcomes: PublishOutcome[];
  running: boolean;
  stopReason?: "stateChanged" | "stateUnavailable" | "warning" | "commitFailed" | "tagFailed";
}
type PublishService = Pick<IGitService, "getPublishState" | "commit" | "createTag" | "push">;
interface ExecutionContext {
  service: PublishService;
  isCurrent: () => boolean;
  onUpdate: (run: PublishRun) => void;
  onCommitted?: (result: GitCommitResult) => void;
}

function publishStepId(kind: PublishOutcome["kind"], ...parts: string[]): string {
  // remote 与 tag 都可能含连字符；转义分隔符后再组合，避免两项目标共享结果/重试身份。
  return [kind, ...parts.map((part) => encodeURIComponent(part).replaceAll("-", "%2D"))].join("-");
}

function initialRun(plan: PublishPlan): PublishRun {
  const outcomes: PublishOutcome[] = [];
  if (plan.commit)
    outcomes.push({ id: "commit", kind: "commit", target: plan.commit.message, status: "pending" });
  if (plan.options.pushBranch) {
    for (const remote of plan.options.remotes)
      outcomes.push({
        id: publishStepId("branch", remote.name),
        kind: "branch",
        remote: remote.name,
        target: remote.branch,
        status: "pending",
      });
  }
  const creates = plan.options.tagMode === "create" || plan.options.tagMode === "create-and-push";
  if (creates)
    outcomes.push({
      id: publishStepId("create-tag", plan.options.tagName),
      kind: "create-tag",
      target: plan.options.tagName,
      status: "pending",
    });
  const tags =
    plan.options.tagMode === "push-existing"
      ? plan.tags
      : plan.options.tagMode === "create-and-push"
        ? [{ name: plan.options.tagName, commitHash: "" }]
        : [];
  for (const tag of tags) {
    for (const remote of plan.options.remotes)
      outcomes.push({
        id: publishStepId("tag", remote.name, tag.name),
        kind: "tag",
        remote: remote.name,
        target: tag.name,
        commitHash: tag.commitHash || undefined,
        status: "pending",
      });
  }
  return { plan, state: plan.state, outcomes, running: true };
}

function updateOutcome(run: PublishRun, id: string, patch: Partial<PublishOutcome>): PublishRun {
  return {
    ...run,
    outcomes: run.outcomes.map((row) => (row.id === id ? { ...row, ...patch } : row)),
  };
}

function stop(run: PublishRun, reason: PublishRun["stopReason"]): PublishRun {
  return {
    ...run,
    running: false,
    stopReason: reason,
    outcomes: run.outcomes.map((row) =>
      row.status === "pending" || row.status === "running" ? { ...row, status: "skipped" } : row,
    ),
  };
}

async function checkState(
  context: ExecutionContext,
  run: PublishRun,
): Promise<PublishRun["stopReason"] | "closed" | null> {
  if (!context.isCurrent()) return "closed";
  try {
    const current = await context.service.getPublishState(run.plan.request);
    if (!context.isCurrent()) return "closed";
    return samePublishState(run.state, current) ? null : "stateChanged";
  } catch {
    return context.isCurrent() ? "stateUnavailable" : "closed";
  }
}

function emit(context: ExecutionContext, run: PublishRun): void {
  if (context.isCurrent()) context.onUpdate(run);
}

async function pushStep(context: ExecutionContext, run: PublishRun, row: PublishOutcome) {
  return context.service.push({
    ...run.plan.request,
    remote: row.remote,
    expectedState: run.state,
    ...(row.kind === "branch"
      ? { branch: row.target }
      : {
          tag: row.target,
          tagCommitHash: row.commitHash ?? run.state.headCommitHash ?? undefined,
        }),
  });
}

/** 无队列/持久化：只解释 owner 冻结的计划；每次 await 两侧都验证代次，迟到结果不再写 UI。 */
export async function executePublishPlan(
  context: ExecutionContext & { plan: PublishPlan },
): Promise<PublishRun> {
  let run = initialRun(context.plan);
  emit(context, run);
  for (const original of run.outcomes) {
    const invalid = await checkState(context, run);
    if (invalid === "closed") return { ...run, running: false };
    if (invalid) {
      run = stop(run, invalid);
      break;
    }
    const row = {
      ...original,
      commitHash: original.commitHash ?? run.state.headCommitHash ?? undefined,
    };
    run = updateOutcome(run, row.id, { status: "running", commitHash: row.commitHash });
    emit(context, run);
    try {
      if (row.kind === "commit") {
        const result = await context.service.commit(context.plan.commit!);
        if (!context.isCurrent()) return { ...run, running: false };
        run = updateOutcome(run, row.id, {
          status: "success",
          commitHash: result.commitHash,
          message: result.warning,
        });
        context.onCommitted?.(result);
        // 提交成功不等于允许发布：hook 警告、缺失版本或工作树变化必须保留提交事实并停止。
        if (result.warning) {
          run = stop(run, "warning");
          break;
        }
        if (
          !result.publishState ||
          result.publishState.headCommitHash !== result.commitHash ||
          result.publishState.branchName !== run.state.branchName ||
          result.publishState.worktreeFingerprint !== run.state.worktreeFingerprint
        ) {
          run = stop(run, "stateChanged");
          break;
        }
        run = { ...run, state: Object.freeze({ ...result.publishState }) };
      } else if (row.kind === "create-tag") {
        const result = await context.service.createTag({
          ...run.plan.request,
          name: row.target,
          ref: run.state.headCommitHash ?? undefined,
          expectedState: run.state,
        });
        if (!context.isCurrent()) return { ...run, running: false };
        // 幂等创建不是新建；保留 Host 的 created 事实，不能把已存在的 Tag 误报为刚创建。
        run = updateOutcome(run, row.id, {
          status: "success",
          commitHash: result.commitHash,
          tagCreated: result.created,
        });
        if (result.commitHash !== run.state.headCommitHash) {
          run = stop(run, "stateChanged");
          break;
        }
      } else {
        const result = await pushStep(context, run, row);
        if (!context.isCurrent()) return { ...run, running: false };
        run = updateOutcome(run, row.id, { status: "success", message: result.warning });
        if (result.warning) {
          run = stop(run, "warning");
          break;
        }
      }
      emit(context, run);
    } catch (error) {
      if (!context.isCurrent()) return { ...run, running: false };
      run = updateOutcome(run, row.id, { status: "failed", message: getErrorMessage(error) });
      if (row.kind === "commit" || row.kind === "create-tag") {
        run = stop(run, row.kind === "commit" ? "commitFailed" : "tagFailed");
        break;
      }
      emit(context, run);
    }
    // 网络错误可隔离；版本变化不可隔离，最后一项后也检查以禁止旧状态重试。
    const changed = await checkState(context, run);
    if (changed === "closed") return { ...run, running: false };
    if (changed) {
      run = stop(run, changed);
      break;
    }
  }
  run = { ...run, running: false };
  emit(context, run);
  return run;
}

export async function retryPublishStep(
  context: ExecutionContext & { run: PublishRun; stepId: string },
): Promise<PublishRun> {
  let run = context.run;
  const row = run.outcomes.find((item) => item.id === context.stepId);
  if (
    !row ||
    row.status !== "failed" ||
    (row.kind !== "branch" && row.kind !== "tag") ||
    run.stopReason ||
    run.running ||
    !context.isCurrent()
  )
    return run;
  run = { ...run, running: true };
  emit(context, run);
  const invalid = await checkState(context, run);
  if (invalid === "closed") return { ...run, running: false };
  if (invalid) {
    run = stop(run, invalid);
    emit(context, run);
    return run;
  }
  run = updateOutcome(run, row.id, { status: "running", message: undefined });
  emit(context, run);
  try {
    const result = await pushStep(context, run, row);
    if (!context.isCurrent()) return { ...run, running: false };
    run = updateOutcome(run, row.id, { status: "success", message: result.warning });
    if (result.warning) run = stop(run, "warning");
  } catch (error) {
    if (!context.isCurrent()) return { ...run, running: false };
    run = updateOutcome(run, row.id, { status: "failed", message: getErrorMessage(error) });
  }
  const changed = await checkState(context, run);
  if (changed === "closed") return { ...run, running: false };
  if (changed) run = stop(run, changed);
  run = { ...run, running: false };
  emit(context, run);
  return run;
}
