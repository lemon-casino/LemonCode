import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowToolOperationAdmission } from "./workflow-tool-operation-admission.js";

const cwd = process.cwd();
const file = (toolName: string, file_path: string, readOnly = false) => ({
  toolName,
  toolInput: { file_path },
  readOnly,
  sideEffectScope: readOnly ? "none" as const : "workspace" as const,
  workingDirectory: cwd,
  workspaceRoot: cwd,
});

test("same-file writes wait while disjoint files and readers proceed", async () => {
  const gate = createWorkflowToolOperationAdmission();
  const releaseFirst = await gate.acquire(file("Edit", "package.json"));
  let admittedSame = false;
  const same = gate.acquire(file("Write", "./package.json")).then((release) => {
    admittedSame = true;
    return release;
  });
  const releaseOther = await gate.acquire(file("Write", "pnpm-lock.yaml"));
  const releaseReader = await gate.acquire(file("Read", "mise.toml", true));
  await Promise.resolve();
  assert.equal(admittedSame, false);
  releaseOther();
  releaseReader();
  releaseFirst();
  (await same)();
  assert.equal(admittedSame, true);
});

test("unknown workspace writes wait for all file readers, but two readers coexist", async () => {
  const gate = createWorkflowToolOperationAdmission();
  const releaseRead = await gate.acquire(file("Read", "package.json", true));
  const releaseRead2 = await gate.acquire(file("Read", "package.json", true));
  let admitted = false;
  const shell = gate.acquire({
    ...file("Bash", "untrusted"),
    toolInput: { command: "echo > some-file" },
  }).then((release) => {
    admitted = true;
    return release;
  });
  await Promise.resolve();
  assert.equal(admitted, false);
  releaseRead();
  await Promise.resolve();
  assert.equal(admitted, false);
  releaseRead2();
  (await shell)();
  assert.equal(admitted, true);
});

test("aborting a queued operation removes it without blocking later requests", async () => {
  const gate = createWorkflowToolOperationAdmission();
  const releaseFirst = await gate.acquire(file("Write", "package.json"));
  const controller = new AbortController();
  const queued = gate.acquire({ ...file("Read", "package.json", true), signal: controller.signal });
  controller.abort();
  await assert.rejects(queued, /cancelled/);
  releaseFirst();
  (await gate.acquire(file("Edit", "package.json")))();
});
