import assert from "node:assert/strict";
import test from "node:test";
import type { WorktreeIntegration } from "@lcode/services";
import { worktreeCandidateEvidenceSchema, worktreeValidationReceiptSchema } from "@lcode/shared";
import { candidateEvidenceState } from "./worktreeCandidateEvidence.js";

function candidate(skip = false): WorktreeIntegration {
  const environmentRef = { environmentId: "a".repeat(32), revision: 2, manifestDigest: "manifest" };
  const receipt = worktreeValidationReceiptSchema.parse({
    candidateHead: "head",
    candidateTree: "tree",
    sourceHead: "source",
    targetHead: "target",
    targetBranch: "main",
    environmentPolicy: "managed",
    environmentRef,
    revision: 2,
    manifestDigest: "manifest",
    declarationDigest: "declaration",
    command: skip ? null : "pnpm test",
    outcome: skip ? "skipped" : "passed",
    exitCode: skip ? null : 0,
    output: "",
    verifiedAt: "now",
    ...(skip ? { skipAcknowledged: true } : {}),
  });
  const evidence = worktreeCandidateEvidenceSchema.parse({
    candidateHead: "head",
    candidateTree: "tree",
    sourceHead: "source",
    targetHead: "target",
    targetBranch: "main",
    environmentPolicy: "managed",
    environmentRef,
    manifestDigest: "manifest",
    declarationDigest: "declaration",
    validationCommands: skip ? [] : ["pnpm test"],
    validationReceipts: [receipt],
    validatedAt: "now",
  });
  return {
    id: "op",
    requestId: "request",
    bindingId: "binding",
    sourceHead: "source",
    targetHead: "target",
    targetBranch: "main",
    targetPath: "repo",
    checkoutPath: "candidate",
    candidateHead: "head",
    status: "ready",
    conflictPaths: [],
    validationCommands: skip ? [] : ["pnpm test"],
    validationResults: [],
    environmentPolicy: "managed",
    environmentRef,
    candidateEvidence: evidence,
    validationReceipts: [receipt],
    createdAt: "now",
    updatedAt: "now",
  };
}

test("ready 与复选框不是收据；精确 owner 证据才允许合并", () => {
  const operation = candidate();
  assert.equal(candidateEvidenceState(operation), "passed");
  assert.equal(candidateEvidenceState({ ...operation, candidateEvidence: undefined }), "missing");
  assert.equal(candidateEvidenceState({ ...operation, validationReceipts: undefined }), "missing");
  for (const patch of [
    { candidateHead: "changed" },
    { sourceHead: "changed" },
    { targetHead: "changed" },
    { targetBranch: "other" },
    { validationCommands: ["pnpm lint"] },
  ])
    assert.equal(candidateEvidenceState({ ...operation, ...patch }), "missing");
  assert.equal(
    candidateEvidenceState({
      ...operation,
      environmentRef: { ...operation.environmentRef!, manifestDigest: "lock-changed" },
    }),
    "missing",
  );
  assert.equal(
    candidateEvidenceState({
      ...operation,
      environmentRef: { ...operation.environmentRef!, revision: 3 },
    }),
    "missing",
  );
});

test("显式 skip receipt 区别于通过，schema 拒绝未确认跳过", () => {
  const operation = candidate(true);
  assert.equal(candidateEvidenceState(operation), "skipped");
  const original = operation.validationReceipts?.[0];
  assert.ok(original);
  const receipt = { ...original, skipAcknowledged: false };
  assert.equal(worktreeValidationReceiptSchema.safeParse(receipt).success, false);
  assert.equal(candidateEvidenceState({ ...operation, validationReceipts: [receipt] }), "missing");
  assert.equal(
    candidateEvidenceState({ ...candidate(), validationReceipts: operation.validationReceipts }),
    "missing",
  );
});
