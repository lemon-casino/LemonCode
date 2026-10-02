import { fork } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  ARM_TIMEOUT_MS,
  BENCHMARK_VERSION,
  CLEANUP_TIMEOUT_MS,
  OUTPUT_CAP,
  PAIR_ORDERS,
  SELECTION,
  canonical,
  fixtureFingerprints,
  makeFixture,
  type Arm,
} from "./fixtures.js";
import { ArmMetrics, pairedSummary, type ArmResult } from "./metrics.js";

const OUTPUT = new URL(
  "../../../../../../../docs/benchmarks/workflow-model-efficiency-2026-10-02.json",
  import.meta.url,
);
const WORKER = new URL("./worker.ts", import.meta.url);
const STARTUP_TIMEOUT_MS = 60_000;
const WORKER_GRACE_MS = 10_000;
interface Preparation {
  pair: number;
  arm: Arm;
  preparation: Record<string, unknown>;
}
interface Report {
  schemaVersion: number;
  benchmarkVersion: number;
  date: string;
  status: string;
  settings: Record<string, unknown>;
  preparation: Preparation[];
  arms: ArmResult[];
  summary: ReturnType<typeof pairedSummary>;
  limitations: string[];
}

function publicLine(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function initialReport(): Report {
  return {
    schemaVersion: 1,
    benchmarkVersion: BENCHMARK_VERSION,
    date: "2026-10-02",
    status: "prepared",
    settings: {
      selection: SELECTION,
      maxOutputTokens: OUTPUT_CAP,
      armTimeoutMs: ARM_TIMEOUT_MS,
      pairOrders: PAIR_ORDERS,
      plannedLogicalRequests: 30,
      armA: "old_serial_A_then_B_then_C",
      armB: "early_parallel_A_and_B_then_C",
      tools: [],
      resultCache: false,
      outputRetention: "in_memory_only",
      ttfdDefinition: "first_engine_node_settled_ok_after_exact_synthetic_validation",
      totalDefinition: "engine_construction_to_final_validation_and_settlement_monotonic_ms",
      requestDurationDefinition:
        "adapter duration includes attempt setup/admission; observed request duration is started-to-terminal",
      backoffDefinition: "scheduled delay only; actual sleep not instrumented",
      reasoningUsageDefinition: "subset_of_output_never_added_to_total",
      fixtures: Array.from({ length: 5 }, (_, index) => ({
        pair: index + 1,
        fingerprints: fixtureFingerprints(makeFixture(index + 1)),
      })),
    },
    preparation: [],
    arms: [],
    summary: pairedSummary([]),
    limitations: [
      "Controlled three-task orchestration plus real provider; not a full application or conversation benchmark.",
      "WorkflowEngine and adapter use existing public dist; governor uses production source/default ceiling.",
      "Each arm starts a fresh process/governor and blank in-memory journal; no production sessions or caches.",
      "Two independent investigations and one dependent integration; no tools, workspace reads, title, maintenance, or UI.",
      "Prompt, validator, output cap and logical task counts are identical within pairs; no validation repair or selective reruns.",
      "Provider retries preserve production workflow policy but all requests share a 10-minute arm abort deadline.",
      "Provider-side prompt caching and external provider load are not controlled; actual reported cache usage is separate.",
      "First text is not a validated delivery. Missing usage is null; reasoning tokens are an output subset.",
      "Scheduled retry delay is not actual sleep; overlapping request durations are not summed as wall time.",
      "Five exploratory pairs do not establish stable p95, statistical significance, or complex-session splitting reliability.",
      "No persistent provider payloads or outputs; no raw errors, endpoints, credentials, or local paths in this report.",
    ],
  };
}

async function save(report: Report): Promise<void> {
  report.summary = pairedSummary(report.arms);
  await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8" });
}

function failedArm(
  pair: number,
  arm: Arm,
  reason: string,
  preparation: Record<string, unknown>,
  elapsed: number,
): ArmResult {
  const metrics = new ArmMetrics(0, () => elapsed).snapshot();
  // 强杀时不能把未回报的真实请求伪造为零用量；requests 数只是已收到结果的观测下界。
  return {
    pair,
    arm,
    success: false,
    failureReason: reason,
    engineStatus: "worker_interrupted",
    cleanupCompleted: false,
    preparation: { ...preparation, metricsCompleteness: "worker_result_missing" },
    metrics,
  };
}

async function executeWorker(
  pair: number,
  arm: Arm,
  report: Report,
  preflightOnly: boolean,
): Promise<ArmResult | null> {
  const started = performance.now();
  const worker = fork(fileURLToPath(WORKER), [], {
    execArgv: ["--import", new URL("./register.mjs", import.meta.url).href],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  // 不转发 AI SDK 的默认警告/网络堆栈；结构化 metrics 仅走 IPC allowlist。
  worker.stdout?.resume();
  worker.stderr?.resume();
  let prepared: Record<string, unknown> = {};
  let settled = false;
  let timer: ReturnType<typeof setTimeout>;
  return new Promise<ArmResult | null>((resolve) => {
    const finish = (result: ArmResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!worker.killed) worker.kill();
      resolve(result);
    };
    timer = setTimeout(
      () => finish(failedArm(pair, arm, "worker_timeout", prepared, performance.now() - started)),
      STARTUP_TIMEOUT_MS,
    );
    worker.on("message", (message: { type: string; value: unknown }) => {
      void (async () => {
        if (message.type === "ready") {
          const ready = message.value as Preparation;
          if (ready.pair !== pair || ready.arm !== arm) throw new Error("worker_protocol_error");
          prepared = ready.preparation;
          const first = report.preparation[0]?.preparation;
          if (
            first &&
            (canonical(first.hashes) !== canonical(prepared.hashes) || first.node !== prepared.node)
          )
            throw new Error("artifacts_changed");
          clearTimeout(timer);
          if (preflightOnly) {
            publicLine({ preflight: "passed", ...prepared });
            finish(null);
            return;
          }
          report.preparation.push(ready);
          report.status = "running";
          await save(report);
          timer = setTimeout(
            () =>
              finish(failedArm(pair, arm, "worker_timeout", prepared, performance.now() - started)),
            ARM_TIMEOUT_MS + CLEANUP_TIMEOUT_MS + WORKER_GRACE_MS,
          );
          publicLine({ event: "arm_started", pair, arm, model: SELECTION });
          worker.send({ type: "go" });
        } else if (message.type === "result") {
          const result = message.value as ArmResult;
          if (result.pair !== pair || result.arm !== arm) throw new Error("worker_protocol_error");
          finish(result);
        } else if (message.type === "failure") {
          finish(failedArm(pair, arm, "worker_failed", prepared, performance.now() - started));
        }
      })().catch(() =>
        finish(failedArm(pair, arm, "worker_failed", prepared, performance.now() - started)),
      );
    });
    worker.on("error", () =>
      finish(failedArm(pair, arm, "worker_failed", prepared, performance.now() - started)),
    );
    worker.on("exit", () => {
      if (!settled)
        finish(failedArm(pair, arm, "worker_failed", prepared, performance.now() - started));
    });
    worker.send({ type: "start", pair, arm, preflightOnly });
  });
}

export async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help")) {
    publicLine({
      usage: [
        "node <this-directory>/launch.mjs --preflight",
        "node <this-directory>/launch.mjs --real --until-pair=1",
        "node <this-directory>/launch.mjs --real --resume --until-pair=5",
        "node --import <this-directory>/register.mjs --test <this-directory>/pure.test.ts",
      ],
      note: "Real calls require --real; existing results are never overwritten without --resume; failed arms are never rerun.",
    });
    return;
  }
  const allowed = new Set([
    "--real",
    "--resume",
    "--preflight",
    "--until-pair=1",
    "--until-pair=5",
  ]);
  if (argv.some((arg) => !allowed.has(arg))) throw new Error("arguments_invalid");
  const preflightOnly = argv.includes("--preflight");
  if (!preflightOnly && !argv.includes("--real"))
    throw new Error("real_calls_require_explicit_flag");
  let report = initialReport();
  const existing = await readFile(OUTPUT, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!preflightOnly && existing !== null) {
    if (!argv.includes("--resume")) throw new Error("existing_results_require_resume");
    report = JSON.parse(existing) as Report;
    if (
      report.benchmarkVersion !== BENCHMARK_VERSION ||
      canonical(report.settings) !== canonical(initialReport().settings)
    )
      throw new Error("benchmark_settings_changed");
    // 中断前已获准启动的臂也记失败；不能把 crash 当成可择优重跑的空白样本。
    for (const ready of report.preparation) {
      if (!report.arms.some((arm) => arm.pair === ready.pair && arm.arm === ready.arm))
        report.arms.push(
          failedArm(ready.pair, ready.arm, "worker_failed", ready.preparation, ARM_TIMEOUT_MS),
        );
    }
  }
  if (preflightOnly) {
    const result = await executeWorker(1, "A", report, true);
    if (result) throw new Error("preflight_failed");
    return;
  }
  const until = argv.includes("--until-pair=1") ? 1 : 5;
  await save(report);
  for (let pair = 1; pair <= until; pair += 1) {
    for (const arm of PAIR_ORDERS[pair - 1]!.split("") as Arm[]) {
      if (report.arms.some((item) => item.pair === pair && item.arm === arm)) continue;
      const result = await executeWorker(pair, arm, report, false);
      if (!result) throw new Error("worker_result_missing");
      report.arms.push(result);
      await save(report);
      publicLine({
        event: "arm_completed",
        pair,
        arm,
        success: result.success,
        failureReason: result.failureReason,
        ttfdMs: result.metrics.ttfdMs,
        totalMs: result.metrics.totalMs,
        acceptedTasks: result.metrics.acceptedTasks,
        logicalRequests: result.metrics.logicalRequests,
        requestsStarted: result.metrics.requestsStarted,
      });
    }
  }
  report.status = report.arms.length === 10 ? "completed" : "first_pair_recorded";
  await save(report);
  publicLine({ status: report.status, summary: report.summary });
}
