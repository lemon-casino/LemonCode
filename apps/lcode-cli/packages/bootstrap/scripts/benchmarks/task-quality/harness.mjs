import { summarize, pairedComparisons, renderReport } from "./reporting.mjs";
export { pairedComparisons } from "./reporting.mjs";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, appendFile, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FIXTURE_VERSION, TASKS } from "./fixtures.mjs";
import { runProcess } from "./process.mjs";
import {
  createArmConfig,
  createArmEnvironment,
  treatmentEvidence,
  observedSelections,
  memoryTreatmentEvidence,
} from "./isolation.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const fakeCli = fileURLToPath(new URL("./fake-cli.mjs", import.meta.url));
const unknownUsage = () => ({
  tokenCoverage: "incomplete",
  totalTokens: null,
  maintenanceTokens: null,
  cost: null,
});

export function parseResult(text) {
  const records = text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  if (
    records.filter((record) => record?.type === "result").length !== 1 ||
    records.at(-1)?.type !== "result"
  )
    throw new Error("terminal_result_missing_or_invalid");
  return records.at(-1);
}

export function validateOptions(options) {
  if (!options.real) return;
  if (!options.cli || !options.config) throw new Error("real mode requires --cli and --config");
  for (const key of [
    "timeoutMs",
    "maxOutputBytes",
    "maxRequests",
    "maxArmTokens",
    "maxTotalTokens",
  ]) {
    if (!Number.isSafeInteger(options[key]) || options[key] <= 0)
      throw new Error(`real mode requires positive ${key}`);
  }
  if (options.maxArmTokens > options.maxTotalTokens)
    throw new Error("arm token budget exceeds total");
  if (!["goal", "workflow", "memory"].includes(options.experiment))
    throw new Error("real mode requires experiment goal, workflow or memory");
}

export async function runSuite(options = {}) {
  validateOptions(options);
  const output = resolve(options.output ?? `task-quality-${Date.now()}`);
  await mkdir(output, { recursive: true });
  const existingOutputs = await Promise.all(
    ["run.json", "results.ndjson", "report.json", "report.md"].map(async (name) => {
      try {
        await lstat(join(output, name));
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    }),
  );
  if (existingOutputs.some(Boolean)) throw new Error("benchmark_output_already_used");
  try {
    await writeFile(
      join(output, "run.json"),
      JSON.stringify({ schemaVersion: 1, runId: randomUUID(), real: options.real === true }),
      { flag: "wx" },
    );
    await writeFile(join(output, "results.ndjson"), "", { flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("benchmark_output_already_used");
    throw error;
  }
  const cli = options.real ? resolve(options.cli) : fakeCli;
  const buildHash = hash(await readFile(cli));
  // Config is explicitly supplied by the caller; never discover/copy production configuration.
  const config = options.real ? JSON.parse(await readFile(options.config, "utf8")) : {};
  const configHash = hash(JSON.stringify(redact(config)));
  const results = [];
  let remaining = options.maxTotalTokens ?? Number.MAX_SAFE_INTEGER;
  const tasks = options.tasks ?? TASKS,
    arms =
      options.arms ??
      (options.experiment === "goal"
        ? ["legacy", "strict"]
        : options.experiment === "workflow"
          ? ["single", "workflow"]
          : options.experiment === "memory"
            ? ["off", "fixed", "maintenance"]
            : ["baseline", "candidate"]);
  let stopReason = null;
  taskLoop: for (const [index, task] of tasks.entries()) {
    for (const arm of index % 2 === 0 ? arms : [...arms].reverse()) {
      if (options.signal?.aborted) {
        stopReason = "cancelled";
        break taskLoop;
      }
      const maxReservedTokens = Math.min(options.maxArmTokens ?? 1000000, remaining);
      if (maxReservedTokens <= 0) {
        stopReason = "global-token-budget";
        break taskLoop;
      }
      // Reserve the entire arm allowance, even after failure/unknown usage; never oversell.
      if (options.real) remaining -= maxReservedTokens;
      const result = await runArm({
        options,
        task,
        arm,
        cli,
        config,
        maxReservedTokens,
        buildHash,
        configHash,
      });
      results.push(result);
      await appendFile(join(output, "results.ndjson"), JSON.stringify(result) + "\n");
    }
  }
  const report = {
    schemaVersion: 1,
    real: options.real === true,
    fixtureVersion: FIXTURE_VERSION,
    fixtureHash: hash(JSON.stringify(TASKS)),
    buildHash,
    configHash,
    requestedArms: arms,
    requestedTasks: tasks.map((t) => t.id),
    plannedSamples: tasks.length * arms.length,
    executedSamples: results.length,
    complete: results.length === tasks.length * arms.length && !options.signal?.aborted,
    stopReason: options.signal?.aborted ? "cancelled" : stopReason,
    results,
    summary: summarize(results),
    comparisons: pairedComparisons(
      results,
      arms,
      tasks.map((task) => task.id),
    ),
    limitations: [
      "Synthetic tasks do not establish production improvement.",
      "Cost is null without authoritative prices.",
      "Repair count is null unless observed by an independent grader.",
      "Memory arms share zero-model-call L0 instrumentation; its IO is included in measured duration.",
      "Single-task isolated memory arms measure injection and maintenance overhead, not learning gains on later tasks.",
      "Windows descendants after abnormal parent exit require Job Object support for complete cleanup; unconfirmed cleanup is a harness error.",
    ],
  };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
  });
  await writeFile(join(output, "report.md"), renderReport(report), { flag: "wx" });
  return report;
}

async function runArm({
  options,
  task,
  arm,
  cli,
  config,
  maxReservedTokens,
  buildHash,
  configHash,
}) {
  const root = await mkdtemp(join(tmpdir(), "lcode-task-quality-"));
  const workspace = join(root, "workspace"),
    home = join(root, "home"),
    storage = join(root, "storage");
  let memoryRoot;
  const started = performance.now();
  const record = {
    schemaVersion: 1,
    taskId: task.id,
    category: task.category,
    arm,
    workspaceId: randomUUID(),
    buildHash,
    configHash,
    fixtureVersion: FIXTURE_VERSION,
    status: "harness-error",
    durationMs: 0,
    repairCount: null,
    firstDeliveryPassed: false,
    usage: unknownUsage(),
    reservedBudget: maxReservedTokens,
  };
  try {
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(join(home, ".lcode", "cli"), { recursive: true }),
      mkdir(storage, { recursive: true }),
    ]);
    for (const [name, body] of Object.entries(task.files))
      await writeFile(join(workspace, name), body);
    const verificationBody = `import assert from 'node:assert/strict';\nimport * as m from './answer.mjs';\n${task.checks}\n`;
    await writeFile(join(workspace, "verify.mjs"), verificationBody);
    const armConfig = createArmConfig(config, storage, options.experiment, arm);
    record.isolation = {
      extensionsDisabled: true,
      sessionRecallDisabled: true,
      observationEnabled: options.experiment === "memory",
      rankingDisabled: true,
    };
    // The experiment definition is explicit; unknown arms never secretly change model settings.
    if (options.experiment === "memory") {
      armConfig.features = { ...armConfig.features, memory: true };
      armConfig.memory = { ...armConfig.memory, use: arm !== "off" };
      const { resolveProjectMemoryRoot } = await import("@lcode/core");
      memoryRoot = resolveProjectMemoryRoot({
        cliStorageRoot: join(storage, "cli"),
        workspacePath: workspace,
      });
      if (arm === "fixed" || arm === "maintenance") {
        await mkdir(memoryRoot, { recursive: true });
        await writeFile(
          join(memoryRoot, "repair-pattern.md"),
          "---\ndescription: Synthetic repository validation observations\nmetadata:\n  type: reference\n---\nFor synthetic parser and state changes, run node verify.mjs and retain failed results. Reject stale async completions and preserve input objects.\n",
        );
        await writeFile(
          join(memoryRoot, "MEMORY.md"),
          "# Project memory\n\n- [Validation observations](repair-pattern.md)\n",
        );
      }
    }
    await writeFile(join(home, ".lcode", "cli", "config.json"), JSON.stringify(armConfig));
    const extra =
      options.experiment === "workflow"
        ? arm === "workflow"
          ? "Use the existing CreateWorkflow tool when decomposing the task; retain a final integrated verification."
          : "Implement in the main agent without creating a workflow."
        : "";
    const prompt = `TASK_ID=${task.id}\nImplement answer.mjs in this isolated synthetic repository. ${task.objective}\n${extra}\nRun node verify.mjs before finishing. Keep verify.mjs and the requirements unchanged.`;
    const args = [
      cli,
      "--cwd",
      workspace,
      "--output-format",
      "stream-json",
      "--benchmark-limits",
      JSON.stringify({ maxRequests: options.maxRequests ?? 10, maxReservedTokens }),
      "-p",
      prompt,
    ];
    if (options.experiment === "memory" && arm === "maintenance") args.push("--memory-bench");
    if (options.experiment === "goal") {
      args.push("--goal");
      if (arm === "strict") {
        const acceptancePath = join(root, "acceptance.json");
        await writeFile(
          acceptancePath,
          JSON.stringify({
            policy: "strict",
            requirements: [
              {
                id: "fixture-tests",
                description: task.objective,
                source: "Bash",
                command: "node verify.mjs",
                inputPaths: ["answer.mjs", "verify.mjs"],
                artifactPaths: [],
              },
            ],
          }),
        );
        args.push("--goal-acceptance", acceptancePath);
      }
    }
    // Carry only OS execution variables and explicitly provided credential variable names.
    const env = createArmEnvironment(home, storage, options.passEnv, process.env, options.fakeMode);
    const outcome = await runProcess(process.execPath, args, {
      cwd: workspace,
      env,
      timeoutMs: options.timeoutMs ?? 10000,
      maxOutputBytes: options.maxOutputBytes ?? 1048576,
      signal: options.signal,
    });
    if (outcome.reason) {
      record.status =
        outcome.reason === "timeout"
          ? "timeout"
          : outcome.reason === "cancelled"
            ? "cancelled"
            : "harness-error";
      record.reason = outcome.reason;
      return record;
    }
    let result;
    try {
      result = parseResult(outcome.stdout);
    } catch {
      record.status = "unverified";
      record.reason = "terminal_result_missing_or_invalid";
      return record;
    }
    record.usage = validatedUsage(result.physicalRequests);
    record.treatment = treatmentEvidence(
      options.experiment,
      arm,
      result,
      outcome.stdout
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line)),
    );
    if (options.experiment === "memory") {
      try {
        const { NodeFileSystemAdapter } = await import("@lcode/adapters/fs");
        const fs = new NodeFileSystemAdapter();
        await fs.projectMemory.registerRoot(memoryRoot);
        const snapshot = await fs.projectMemory.effects.read({
          rootDir: memoryRoot,
          workspaceKey: `sha256:${hash(workspace)}`,
        });
        record.treatment = memoryTreatmentEvidence(arm, snapshot, result.physicalRequests);
      } catch {
        record.treatment = { applied: null, source: "observation-unavailable" };
      }
    }
    record.selection = observedSelections(result.physicalRequests);
    if (outcome.code !== 0) {
      record.status = "harness-error";
      record.reason = "cli_nonzero";
      return record;
    }
    const grader = join(root, "grader.mjs");
    // The grader executes the harness-owned assertions, irrespective of edits to workspace checks.
    const marker = JSON.stringify({ grader: "passed", nonce: randomUUID() });
    await writeFile(
      grader,
      `import assert from 'node:assert/strict';\nconst m=await import(${JSON.stringify(pathToFileURL(join(workspace, "answer.mjs")).href)});\n${task.checks}\nprocess.stdout.write(${JSON.stringify(marker + "\n")});\n`,
    );
    const grade = await runProcess(process.execPath, [grader], {
      cwd: workspace,
      env,
      timeoutMs: 5000,
      maxOutputBytes: 16384,
      signal: options.signal,
    });
    const verificationUnchanged =
      (await readFile(join(workspace, "verify.mjs"), "utf8")) === verificationBody;
    record.status = grade.reason
      ? "harness-error"
      : grade.code === 0 &&
          grade.stdout.trim().split(/\r?\n/).at(-1) === marker &&
          verificationUnchanged
        ? "passed"
        : "task-failed";
    if (!verificationUnchanged) record.reason = "fixture_checks_changed";
    record.firstDeliveryPassed = record.status === "passed";
    record.acceptance = {
      passed: record.firstDeliveryPassed,
      exitCode: grade.code,
      reason: grade.reason ?? null,
    };
    return record;
  } catch {
    record.reason = "harness_exception";
    return record;
  } finally {
    record.durationMs = Math.round(performance.now() - started);
    // root came directly from mkdtemp; no user-provided deletion target.
    await rm(root, { recursive: true, force: true });
  }
}

function validatedUsage(value) {
  if (
    value?.schemaVersion !== 1 ||
    !Array.isArray(value.requests) ||
    !["complete", "incomplete"].includes(value.tokenCoverage)
  )
    return unknownUsage();
  const ids = new Set(value.requests.map((r) => r.requestId));
  if (ids.size !== value.requests.length) return unknownUsage();
  const complete =
    value.tokenCoverage === "complete" &&
    value.requests.length > 0 &&
    value.requests.every(
      (r) =>
        r.status === "completed" &&
        Number.isSafeInteger(r.totalTokens) &&
        r.totalTokens >= 0 &&
        r.startedAt &&
        r.completedAt,
    );
  const sum = value.requests.reduce(
    (n, r) => n + (Number.isSafeInteger(r.totalTokens) && r.totalTokens >= 0 ? r.totalTokens : 0),
    0,
  );
  return {
    tokenCoverage: complete ? "complete" : "incomplete",
    totalTokens: complete ? sum : null,
    knownTokens: sum,
    maintenanceTokens: value.maintenanceTokens ?? null,
    requestCount: value.requests.length,
    reservedTokens: value.reservedTokens ?? null,
    cost: null,
  };
}
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        /key|token|secret|password|header/i.test(key) ? "[redacted]" : redact(v),
      ]),
    );
  return value;
}
