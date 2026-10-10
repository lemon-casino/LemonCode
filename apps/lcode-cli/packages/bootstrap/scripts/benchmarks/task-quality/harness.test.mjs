import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TASKS } from "./fixtures.mjs";
import { parseResult, pairedComparisons, runSuite, validateOptions } from "./harness.mjs";
import {
  createArmConfig,
  createArmEnvironment,
  observedSelections,
  memoryTreatmentEvidence,
  treatmentEvidence,
} from "./isolation.mjs";
import { runProcess } from "./process.mjs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

test("only a single terminal result is accepted", () => {
  assert.deepEqual(parseResult('{"type":"event"}\n{"type":"result","ok":true}\n'), {
    type: "result",
    ok: true,
  });
  for (const text of [
    "",
    "{}",
    '{"type":"result"}\n{}',
    '{"type":"result"}\n{"type":"result"}',
    "not json",
  ])
    assert.throws(() => parseResult(text));
});
test("real mode requires explicit CLI/config and every budget", () => {
  assert.throws(() => validateOptions({ real: true }), /real/);
});
test("all fixed tasks pass offline, paired arms use isolated directories and fixed grading", async () => {
  const output = await mkdtemp(join(tmpdir(), "lcode-quality-test-"));
  try {
    const report = await runSuite({
      output,
      tasks: TASKS,
      arms: ["baseline", "candidate"],
      timeoutMs: 10000,
    });
    assert.equal(report.results.length, 24);
    assert.ok(report.results.every((r) => r.status === "passed"));
    assert.equal(new Set(report.results.map((r) => r.workspaceId)).size, 24);
    assert.equal(report.real, false);
    assert.equal(report.results[0].usage.totalTokens, null);
    assert.ok((await readFile(join(output, "report.json"), "utf8")).includes("fixtureVersion"));
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
test("failure, missing result, timeout and output bounds do not become task success", async () => {
  for (const [mode, status] of [
    ["wrong", "task-failed"],
    ["exit-zero", "task-failed"],
    ["tamper", "task-failed"],
    ["missing", "unverified"],
    ["hang", "timeout"],
    ["flood", "harness-error"],
  ]) {
    const output = await mkdtemp(join(tmpdir(), "lcode-quality-failure-"));
    try {
      const report = await runSuite({
        output,
        tasks: [TASKS[0]],
        arms: ["baseline"],
        fakeMode: mode,
        timeoutMs: mode === "hang" ? 150 : 5000,
        maxOutputBytes: 1024,
      });
      assert.equal(report.results[0].status, status, mode);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  }
});

test("evaluation configuration cannot route persistence or executable extensions to production", () => {
  const input = {
    storage: { dir: "/production", sessionDbPath: "/production/user.sqlite" },
    hooks: { enabled: true, events: { danger: "command" } },
    plugins: { enabled: true, dirs: ["/production/plugins"] },
    skills: { enabled: true, roots: ["/production/skills"] },
    mcp: { servers: { external: { command: "run" } } },
    sessionRecall: { enabled: true },
  };
  const configured = createArmConfig(input, "/isolated/storage", "memory", "fixed");
  assert.equal(input.storage.dir, "/production");
  assert.equal(configured.storage.dir, "/isolated/storage");
  assert.equal(
    configured.storage.sessionDbPath,
    join("/isolated/storage", "cli", "sessions.sqlite"),
  );
  assert.equal(configured.hooks.enabled, false);
  assert.equal(configured.plugins.enabled, false);
  assert.deepEqual(configured.mcp.servers, {});
  assert.equal(configured.sessionRecall.enabled, false);
  assert.equal(configured.memory.observationEnabled, true);
  assert.equal(configured.memory.rankingExperimentEnabled, false);
  const env = createArmEnvironment(
    "/isolated/home",
    "/isolated/storage",
    ["LCODE_SESSION_DB_PATH", "LCODE_RUNTIME_ENV", "PRIVATE_KEY"],
    {
      LCODE_SESSION_DB_PATH: "/production.sqlite",
      LCODE_RUNTIME_ENV: "production",
      PRIVATE_KEY: "synthetic-key",
    },
  );
  assert.equal(env.LCODE_RUNTIME_ENV, "test");
  assert.equal(env.LCODE_SESSION_DB_PATH, configured.storage.sessionDbPath);
  assert.equal(env.PRIVATE_KEY, "synthetic-key");
  assert.equal(env.LCODE_MODEL_TELEMETRY_ENABLED, "false");
});

test("existing output is never replaced and first failed samples remain append-only", async () => {
  const output = await mkdtemp(join(tmpdir(), "lcode-quality-append-"));
  try {
    await runSuite({ output, tasks: [TASKS[0]], arms: ["baseline"], fakeMode: "wrong" });
    const before = await readFile(join(output, "results.ndjson"), "utf8");
    await assert.rejects(
      runSuite({ output, tasks: [TASKS[0]], arms: ["baseline"] }),
      /benchmark_output_already_used/,
    );
    assert.equal(await readFile(join(output, "results.ndjson"), "utf8"), before);
    assert.equal(JSON.parse(before).status, "task-failed");
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("legacy output without a run manifest is rejected before any arm starts", async () => {
  for (const name of ["results.ndjson", "report.json", "report.md"]) {
    const output = await mkdtemp(join(tmpdir(), "lcode-quality-legacy-"));
    try {
      await writeFile(join(output, name), "preserve legacy output");
      await assert.rejects(
        runSuite({ output, tasks: [TASKS[0]], arms: ["baseline"] }),
        /benchmark_output_already_used/,
      );
      assert.equal(await readFile(join(output, name), "utf8"), "preserve legacy output");
      await assert.rejects(readFile(join(output, "run.json")), { code: "ENOENT" });
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  }
});

test("only observed treatments and matching model selections enter paired ratios", () => {
  assert.equal(
    treatmentEvidence(
      "goal",
      "strict",
      {
        benchmarkTreatment: { goal: { policy: "legacy", status: "complete", requirementCount: 0 } },
      },
      [],
    ).applied,
    false,
  );
  assert.equal(
    treatmentEvidence(
      "goal",
      "strict",
      {
        benchmarkTreatment: { goal: { policy: "strict", status: "complete", requirementCount: 1 } },
      },
      [],
    ).applied,
    true,
  );
  const workflow = [
    { type: "workflow.run.progress", payload: { runId: "fixture-run", eventType: "run-started" } },
  ];
  assert.equal(treatmentEvidence("workflow", "workflow", {}, workflow).applied, true);
  assert.equal(treatmentEvidence("workflow", "workflow", {}, []).applied, false);
  assert.equal(observedSelections({ requests: [] }).coverage, "incomplete");
  const selection = {
    coverage: "complete",
    selections: [{ providerId: "fixture", modelId: "model" }],
  };
  const first = {
    taskId: "fixture",
    arm: "baseline",
    status: "passed",
    durationMs: 200,
    treatment: { applied: true },
    selection,
  };
  const next = { ...first, arm: "candidate", durationMs: 100 };
  assert.equal(
    pairedComparisons([first, next], ["baseline", "candidate"])[0].medianDurationRatio,
    2,
  );
  assert.equal(
    pairedComparisons(
      [first, { ...next, treatment: { applied: null } }],
      ["baseline", "candidate"],
    )[0].medianDurationRatio,
    null,
  );
  assert.equal(
    pairedComparisons(
      [first, { ...next, selection: { ...selection, selections: [{ modelId: "other" }] } }],
      ["baseline", "candidate"],
    )[0].pairs[0].excludedReason,
    "selection-mismatch",
  );
});

test("exhausted global budget retains the entire unexecuted plan as missing pairs", async () => {
  const output = await mkdtemp(join(tmpdir(), "lcode-quality-budget-"));
  try {
    const config = join(output, "synthetic-config.json");
    await writeFile(config, "{}");
    const report = await runSuite({
      output,
      real: true,
      cli: fileURLToPath(new URL("./fake-cli.mjs", import.meta.url)),
      config,
      experiment: "workflow",
      tasks: TASKS.slice(0, 2),
      timeoutMs: 5000,
      maxOutputBytes: 16384,
      maxRequests: 1,
      maxArmTokens: 100,
      maxTotalTokens: 100,
    });
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].status, "passed");
    assert.equal(report.plannedSamples, 4);
    assert.equal(report.executedSamples, 1);
    assert.equal(report.complete, false);
    assert.equal(report.stopReason, "global-token-budget");
    assert.deepEqual(
      report.comparisons[0].pairs.map((p) => p.excludedReason),
      ["missing-arm", "missing-arm"],
    );
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("already-cancelled suite reports an incomplete plan, not empty success", async () => {
  const output = await mkdtemp(join(tmpdir(), "lcode-quality-cancel-"));
  const signal = AbortSignal.abort();
  try {
    const report = await runSuite({
      output,
      signal,
      tasks: [TASKS[0]],
      arms: ["baseline", "candidate"],
    });
    assert.equal(report.executedSamples, 0);
    assert.equal(report.plannedSamples, 2);
    assert.equal(report.complete, false);
    assert.equal(report.stopReason, "cancelled");
    assert.equal(report.comparisons[0].pairs[0].excludedReason, "missing-arm");
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("benchmark CLI exits nonzero when the total budget leaves a partial successful suite", async () => {
  const root = await mkdtemp(join(tmpdir(), "lcode-quality-cli-budget-"));
  try {
    const config = join(root, "config.json");
    await writeFile(config, "{}");
    const outcome = await runProcess(
      process.execPath,
      [
        fileURLToPath(new URL("../../task-quality-benchmark.mjs", import.meta.url)),
        "--real",
        "--cli",
        fileURLToPath(new URL("./fake-cli.mjs", import.meta.url)),
        "--config",
        config,
        "--output",
        join(root, "report"),
        "--experiment",
        "workflow",
        "--timeout-ms",
        "5000",
        "--max-output-bytes",
        "16384",
        "--max-requests",
        "1",
        "--max-arm-tokens",
        "100",
        "--max-total-tokens",
        "100",
      ],
      { cwd: root, env: process.env, timeoutMs: 10000, maxOutputBytes: 16384 },
    );
    assert.equal(outcome.code, 1);
    assert.equal(outcome.reason, undefined);
    const result = JSON.parse(outcome.stdout);
    assert.equal(result.complete, false);
    assert.equal(result.stopReason, "global-token-budget");
    assert.equal(result.summary[0].passed, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selection order is canonical and speed differences or missing observations exclude pairs", () => {
  const requests = ["a", "b"].map((modelId) => ({
    kind: "main",
    providerId: "fixture",
    modelId,
    selectedSpeed: null,
  }));
  assert.deepEqual(
    observedSelections({ requests }),
    observedSelections({ requests: [...requests].reverse() }),
  );
  assert.equal(
    observedSelections({ requests: [{ kind: "main", providerId: "fixture", modelId: "a" }] })
      .coverage,
    "incomplete",
  );
  const row = { taskId: "t", status: "passed", durationMs: 1, treatment: { applied: true } };
  const comparison = pairedComparisons(
    [
      { ...row, arm: "a", selection: observedSelections({ requests }) },
      {
        ...row,
        arm: "b",
        selection: observedSelections({
          requests: requests.map((r) => ({ ...r, selectedSpeed: "fast" })),
        }),
      },
    ],
    ["a", "b"],
  );
  assert.equal(comparison[0].pairs[0].excludedReason, "selection-mismatch");
});

test("memory treatment requires actual injection and the assigned maintenance behavior", () => {
  const snapshot = { turnCount: 1, injectedEntries: 1, versionedEntries: 1 };
  const main = { requestId: "main", kind: "main", startedAt: "2026-10-11T00:00:00Z" };
  const maintenance = { requestId: "maintenance", kind: "memory", startedAt: main.startedAt };
  assert.equal(
    memoryTreatmentEvidence("maintenance", snapshot, { requests: [main] }).applied,
    false,
  );
  assert.equal(
    memoryTreatmentEvidence("maintenance", snapshot, { requests: [main, maintenance] }).applied,
    true,
  );
  assert.equal(
    memoryTreatmentEvidence("fixed", snapshot, { requests: [main, maintenance] }).applied,
    false,
  );
  assert.equal(memoryTreatmentEvidence("fixed", snapshot, { requests: [main] }).applied, true);
  assert.equal(
    memoryTreatmentEvidence("off", { ...snapshot, injectedEntries: 0 }, { requests: [main] })
      .applied,
    true,
  );
  assert.equal(memoryTreatmentEvidence("fixed", snapshot, undefined).applied, null);
});

test("UTF-8 split across output chunks is decoded once and orphan pipes have a bounded cleanup result", async () => {
  const unicode = await runProcess(
    process.execPath,
    [
      "-e",
      "const b=Buffer.from('中文');process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),20);",
    ],
    { cwd: process.cwd(), env: process.env, timeoutMs: 2000, maxOutputBytes: 100 },
  );
  assert.equal(unicode.stdout, "中文");
  assert.equal(unicode.reason, undefined);
  // Simulate an exited parent with a held descendant pipe without creating an actual orphan.
  const fakeProcess = new EventEmitter();
  fakeProcess.stdout = new PassThrough();
  fakeProcess.stderr = new PassThrough();
  const orphan = await runProcess("fake-owned-process", [], {
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 2000,
    maxOutputBytes: 100,
    cleanupGraceMs: 50,
    spawnProcess: () => {
      setImmediate(() => fakeProcess.emit("exit", 0));
      return fakeProcess;
    },
  });
  assert.equal(orphan.reason, "cleanup_unconfirmed");
  assert.equal(orphan.cleanupConfirmed, false);
});
