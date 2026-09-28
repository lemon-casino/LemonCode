import {
  collectVisibleLCodeBackgroundTaskControlItems,
  getLCodeBackgroundTaskControlItemElapsedMs,
  isActiveLCodeBackgroundTaskControlItem,
  parseLCodeBackgroundTaskControlItems,
  type LCodeBackgroundTaskControlItem,
  type LCodeBackgroundTaskControlStatus,
} from "./background-task-controls.js";

export type LCodeBackgroundBashJobStatus = LCodeBackgroundTaskControlStatus;
export type LCodeBackgroundBashJob = LCodeBackgroundTaskControlItem & {
  taskKind: "bash";
};

export function parseLCodeBackgroundBashJobs(value: unknown): LCodeBackgroundBashJob[] {
  return parseLCodeBackgroundTaskControlItems(value).filter(isBackgroundBashJob);
}

export function isActiveLCodeBackgroundBashJob(job: LCodeBackgroundBashJob): boolean {
  return isActiveLCodeBackgroundTaskControlItem(job);
}

export function getLCodeBackgroundBashJobElapsedMs(
  job: LCodeBackgroundBashJob,
  now = Date.now(),
): number {
  return getLCodeBackgroundTaskControlItemElapsedMs(job, now);
}

export function collectVisibleLCodeBackgroundBashJobs(
  jobs: readonly LCodeBackgroundBashJob[],
  now = Date.now(),
  thresholdMs = 30_000,
): Array<LCodeBackgroundBashJob & { elapsedMs: number }> {
  return collectVisibleLCodeBackgroundTaskControlItems(jobs, now, thresholdMs) as Array<
    LCodeBackgroundBashJob & { elapsedMs: number }
  >;
}

function isBackgroundBashJob(job: LCodeBackgroundTaskControlItem): job is LCodeBackgroundBashJob {
  return job.taskKind === "bash";
}
