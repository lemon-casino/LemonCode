import type { ExpertWorkflowRunSnapshot } from "@lcode/contracts";

export function formatExpertWorkflowStatus(snapshot: ExpertWorkflowRunSnapshot): string {
  const lines = [
    `Expert workflow ${snapshot.runId}`,
    `Status: ${snapshot.status}`,
    `Task: ${snapshot.task}`,
    `Directory: ${snapshot.cwd}`,
    `Updated: ${snapshot.updatedAt}`,
    "",
    "Phases:",
  ];
  for (const phase of snapshot.phases) {
    const marker = phase.status === "completed" ? "[x]" : phase.status === "active" ? ">" : "-";
    const detail = phase.error ? ` (${phase.error})` : "";
    const activityDetail = phase.activityId
      ? ` | activity ${phase.activityId}${phase.sessionId ? ` | session ${phase.sessionId}` : ""}`
      : "";
    lines.push(`  ${marker} ${phase.phase}: ${phase.status}${activityDetail}${detail}`);
  }
  if (snapshot.reportPath) {
    lines.push("", `Report: ${snapshot.reportPath}`);
  }
  return lines.join("\n");
}

export function formatExpertWorkflowCompletion(snapshot: ExpertWorkflowRunSnapshot): string {
  return [
    `Expert workflow ${snapshot.runId} ${snapshot.status}.`,
    `Task: ${snapshot.task}`,
    snapshot.reportPath ? `Report: ${snapshot.reportPath}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
