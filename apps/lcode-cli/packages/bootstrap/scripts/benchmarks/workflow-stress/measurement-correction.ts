import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../../../../..");
const reportPath = join(root, "docs/benchmarks/workflow-stress-runtime-2026-10-02.json");
if (!process.argv.includes("--run")) throw new Error("Explicit --run required");
const report = JSON.parse(await readFile(reportPath, "utf8"));
assert.equal(report.completed, true, "Do not overwrite a running report");
const initialFailure = report.scenarios.find(
  (entry: { parameters: { actors: number }; passed: boolean }) =>
    entry.parameters.actors === 256 && !entry.passed,
);
assert.ok(initialFailure, "Correction supplements an existing failed sample, never replaces it");
const directory = await mkdtemp(join(tmpdir(), "lcode-workflow-stress-correction-"));
try {
  const output = join(directory, "corrected.json");
  const parameters = { actors: 256, warmupMs: 10_000, durationMs: 60_000, deltasPerSecond: 20 };
  const worker = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      join(here, "run.ts"),
      "--worker",
      JSON.stringify(parameters),
      "--out",
      output,
    ],
    {
      cwd: root,
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    },
  );
  const timer = setTimeout(() => worker.kill(), 190_000);
  const code = await new Promise<number | null>((resolveExit, reject) => {
    worker.once("error", reject);
    worker.once("exit", resolveExit);
  }).finally(() => clearTimeout(timer));
  const corrected = JSON.parse(await readFile(output, "utf8"));
  corrected.measurementCorrection = true;
  corrected.correctionReasons = [
    "Preserve partial resource samples/counts/wall on budget termination, including failure stage",
    "Yield event loop even for overdue 50ms input batches so driver real timers can fire",
  ];
  corrected.workerExitCode = code;
  initialFailure.measurementGap = {
    fieldsLost: ["measuredWallMs", "measuredCounts", "resources", "projection"],
    reason:
      "Initial harness only returned these fields after a complete measurement; stored zero means missing, not zero elapsed",
    failureCategoryFromCapturedStderr: "wall-budget",
    failureStageFromCompletedWarmup: "measured",
    initialCpuNotAttributableToProduct: true,
    overdueTickYieldMissing: true,
  };
  report.scenarios.push(corrected);
  report.metadata.measurementCorrectionRepeats = 1;
  report.metadata.inputScheduling =
    "One wall-clock 50ms batch loops over independently scoped actors; achieved input rate is measured, not an asserted SLO";
  report.metadata.sourceModuleFreeze =
    "Modules fixed in each isolated worker ESM cache after import; pre/post directory hashes detect concurrent on-disk changes. Projection/engine dist were not built by this harness.";
  report.metadata.performanceCaveat =
    "Initial overdue batches did not yield; failed 256 sample is retained and not a valid product CPU claim. Measurement correction preserves the same input target and safety budgets.";
  report.passed = report.scenarios.every((entry: { passed: boolean }) => entry.passed === true);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ phase: "measurement-correction-appended", actors: 256, passed: corrected.passed, failure: corrected.failure, measuredWallMs: corrected.measuredWallMs })}\n`,
  );
  process.exitCode = corrected.passed ? 0 : 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
