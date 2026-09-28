import type { TuiSubmitPromptResult } from "@lcode/tui";
import { attachCurrentSessionMetadata } from "../metadata.js";
import { buildTargetReplaceSelection } from "../selections.js";
import type {
  CommandCenterApp,
  CommandCenterDeps,
  CommandCenterTarget,
  TuiSubmitOptions,
} from "../types.js";
import { splitArgs } from "../utils.js";

const PLAN_MODE_GOAL_CONTINUATION_SKIPPED_MESSAGE =
  "Plan mode 下已记录 goal，但不会自动继续。";

export async function handleTargetCommand(
  args: string,
  deps: CommandCenterDeps,
  options: TuiSubmitOptions,
): Promise<TuiSubmitPromptResult> {
  const app = await deps.getApp();
  const trimmed = args.trim();

  if (!app.readTarget || !app.setTarget || !app.updateTargetStatus || !app.clearTarget) {
    return {
      mode: deps.getMode?.(),
      response: "Goal management is not available in this client.",
    };
  }

  if (trimmed.length === 0) {
    return {
      mode: deps.getMode?.(),
      response: formatTargetSummary(await app.readTarget()),
    };
  }

  const [action] = splitArgs(trimmed);
  if (action === "pause") {
    const target = await app.updateTargetStatus("paused");
    return {
      mode: deps.getMode?.(),
      response: target ? formatTargetChanged("Goal paused", target) : "No goal to pause.",
    };
  }

  if (action === "resume") {
    const target = await app.updateTargetStatus("active");
    if (!target) {
      return {
        mode: deps.getMode?.(),
        response: "No goal to resume.",
      };
    }
    return continueTargetAfterChange("Goal resumed", target, app, deps, options);
  }

  if (action === "clear") {
    const cleared = await app.clearTarget();
    return {
      mode: deps.getMode?.(),
      response: cleared ? "Goal cleared." : "No goal to clear.",
    };
  }

  const forceReplace = action === "replace";
  const objective = forceReplace ? trimmed.replace(/^replace\s*/i, "").trim() : trimmed;
  if (forceReplace && objective.length === 0) {
    return {
      mode: deps.getMode?.(),
      response: "Usage: /goal replace <objective>",
    };
  }

  if (!forceReplace) {
    const existing = await app.readTarget();
    if (existing) {
      return {
        mode: deps.getMode?.(),
        response: "A goal already exists. Confirm replacement to overwrite it.",
        selection: buildTargetReplaceSelection(existing, objective),
      };
    }
  }

  const target = await app.setTarget({ objective, status: "active" });
  return continueTargetAfterChange("Goal active", target, app, deps, options);
}

async function continueTargetAfterChange(
  title: string,
  target: CommandCenterTarget,
  app: CommandCenterApp,
  deps: CommandCenterDeps,
  options: TuiSubmitOptions,
): Promise<TuiSubmitPromptResult> {
  if (!app.continueActiveTarget) {
    return {
      mode: deps.getMode?.(),
      response: formatTargetChanged(title, target),
    };
  }

  const continuation = await app.continueActiveTarget({
    abortSignal: options.abortSignal,
    onEvent: options.onEvent,
  });
  const response = formatTargetChanged(title, target);
  return continuation
    ? attachCurrentSessionMetadata(continuation, deps, app)
    : {
        mode: deps.getMode?.(),
        response: appendPlanModeGoalContinuationNote(response, deps.getMode?.()),
      };
}

function appendPlanModeGoalContinuationNote(response: string, mode: string | undefined): string {
  return mode === "plan"
    ? `${response}\n\n${PLAN_MODE_GOAL_CONTINUATION_SKIPPED_MESSAGE}`
    : response;
}

function formatTargetSummary(target: CommandCenterTarget | null): string {
  if (!target) {
    return "No goal is set. Use /goal <objective> to set one.";
  }

  return formatTargetChanged(`Goal ${target.status}`, target);
}

function formatTargetChanged(title: string, target: CommandCenterTarget): string {
  const lines = [title, `Objective: ${target.objective}`];
  if (target.tokensUsed !== undefined || target.tokenBudget !== undefined) {
    const budget = target.tokenBudget === null || target.tokenBudget === undefined
      ? "none"
      : target.tokenBudget.toString();
    lines.push(`Usage: ${target.tokensUsed ?? 0} tokens / ${budget}`);
  }
  if (target.timeUsedSeconds !== undefined) {
    lines.push(`Time: ${target.timeUsedSeconds} seconds`);
  }
  return lines.join("\n");
}
