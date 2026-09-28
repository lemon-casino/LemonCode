import {
  WorkflowCriticReopenProposalSchema,
  WorkflowCriticResultSchema,
  type WorkflowCriticReopenProposal,
  type WorkflowCriticResult,
} from "@lcode/contracts";
import { isRecord, parsePlannerJson, stringValue } from "./json.js";

export function parseCriticResult(response: string): WorkflowCriticResult {
  const raw = parsePlannerJson(response);
  const normalized = normalizeCriticCandidate(raw);
  if (!normalized) {
    throw new Error("Workflow critic did not return JSON verdict data");
  }
  return normalized;
}

export function dedupeReopenProposals(
  proposals: readonly WorkflowCriticReopenProposal[],
): WorkflowCriticReopenProposal[] {
  const seen = new Set<string>();
  const deduped: WorkflowCriticReopenProposal[] = [];
  for (const proposal of proposals) {
    if (seen.has(proposal.nodeId)) continue;
    seen.add(proposal.nodeId);
    deduped.push(proposal);
  }
  return deduped;
}

function normalizeCriticCandidate(value: unknown): WorkflowCriticResult | null {
  if (!isRecord(value)) return null;
  if (!hasLegacyCriticFields(value)) {
    const direct = WorkflowCriticResultSchema.safeParse(value);
    if (direct.success) return direct.data;
  }

  const verdict =
    value.verdict === "pass" || value.verdict === "fail"
      ? value.verdict
      : typeof value.passed === "boolean"
        ? value.passed
          ? "pass"
          : "fail"
        : typeof value.overallVerdict === "string"
          ? value.overallVerdict === "approved" || value.overallVerdict === "conditionallyApproved"
            ? "pass"
            : "fail"
          : undefined;
  if (!verdict) return null;

  const reasoning =
    stringValue(value.reasoning) ??
    stringValue(value.summary) ??
    (typeof value.verdict === "string" ? value.verdict : "");

  const rawProposals = Array.isArray(value.reopenProposals)
    ? value.reopenProposals
    : Array.isArray(value.reopen_proposals)
      ? value.reopen_proposals
      : Array.isArray(value.reopenNodes)
        ? value.reopenNodes.map((nodeId) => ({
            nodeId,
            reason: reasoning || "critic requested reopen",
          }))
        : [];

  const reopenProposals = rawProposals
    .map(normalizeCriticReopenProposal)
    .filter((proposal): proposal is WorkflowCriticReopenProposal => proposal !== null);
  const acceptanceGaps = Array.isArray(value.acceptanceGaps)
    ? value.acceptanceGaps.map(stringValue).filter((gap): gap is string => gap !== undefined)
    : Array.isArray(value.acceptance_gaps)
      ? value.acceptance_gaps.map(stringValue).filter((gap): gap is string => gap !== undefined)
      : [];

  const parsed = WorkflowCriticResultSchema.safeParse({
    acceptanceGaps,
    reasoning,
    reopenProposals,
    verdict,
  });
  return parsed.success ? parsed.data : null;
}

function hasLegacyCriticFields(value: Record<string, unknown>): boolean {
  return (
    Array.isArray(value.acceptance_gaps) ||
    typeof value.overallVerdict === "string" ||
    typeof value.passed === "boolean" ||
    Array.isArray(value.reopenNodes) ||
    Array.isArray(value.reopen_proposals)
  );
}

function normalizeCriticReopenProposal(value: unknown): WorkflowCriticReopenProposal | null {
  if (!isRecord(value)) return null;
  const nodeId =
    stringValue(value.nodeId) ??
    stringValue(value.node_id) ??
    stringValue(value.nodeName) ??
    stringValue(value.node_name);
  const reason = stringValue(value.reason) ?? stringValue(value.issue);
  if (!nodeId || !reason) return null;
  const severity = value.severity;
  const parsed = WorkflowCriticReopenProposalSchema.safeParse({
    nodeId,
    reason,
    ...(severity === "critical" || severity === "major" || severity === "minor"
      ? { severity }
      : {}),
  });
  return parsed.success ? parsed.data : null;
}
