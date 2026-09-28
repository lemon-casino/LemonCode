import type { LCodeBackgroundTaskControlItem } from "./background-task-controls.js";

export function mergeLCodeBackgroundTaskControlItems(
  current: readonly LCodeBackgroundTaskControlItem[],
  updates: readonly LCodeBackgroundTaskControlItem[],
): LCodeBackgroundTaskControlItem[] {
  const jobsById = new Map(current.map((job) => [job.jobId, job] as const));
  for (const job of updates) {
    jobsById.set(job.jobId, job);
  }
  return Array.from(jobsById.values());
}
