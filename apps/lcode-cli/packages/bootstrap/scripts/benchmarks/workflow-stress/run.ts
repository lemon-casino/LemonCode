import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprint } from "./metrics.js";
import type { StressParameters } from "./harness.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../../../../..");
const args = process.argv.slice(2);
const value = (flag: string) => args[args.indexOf(flag) + 1];
const out = args.includes("--out")
  ? resolve(value("--out")!)
  : join(root, "docs/benchmarks/workflow-stress-runtime-2026-10-02.json");

async function sources() {
  return {
    bootstrapProjectionDist: await fingerprint(
      resolve(here, "../../../dist/lcode-protocol-v4"),
      ".js",
    ),
    workflowEngineDist: await fingerprint(
      resolve(here, "../../../../dynamic-workflow/dist/engine"),
      ".js",
    ),
    driverSourceDirectory: await fingerprint(resolve(here, "../../../src/app"), ".ts"),
    sharedProtocolSource: await fingerprint(
      join(root, "packages/shared/src/lcode-protocol-v4"),
      ".ts",
    ),
  };
}

async function child(parameters: StressParameters, output: string) {
  const worker = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(import.meta.url),
      "--worker",
      JSON.stringify(parameters),
      "--out",
      output,
    ],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  worker.stdout.on("data", (chunk: Buffer) => process.stdout.write(chunk));
  worker.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      worker.kill();
    },
    parameters.warmupMs + parameters.durationMs + 120_000,
  );
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    worker.once("error", reject);
    worker.once("exit", resolveExit);
  }).finally(() => clearTimeout(timer));
  if (timedOut || exitCode === null)
    return { parameters, passed: false, failure: "worker-timeout" };
  try {
    return JSON.parse(await readFile(output, "utf8")) as Record<string, unknown>;
  } catch {
    return { parameters, passed: false, failure: "worker-no-result", exitCode };
  }
}

if (args.includes("--worker")) {
  const parameters = JSON.parse(value("--worker")!) as StressParameters;
  const hashesBefore = await sources();
  const { runStress } = await import("./harness.js");
  const moduleLoadedAt = Date.now();
  const result = await runStress(parameters);
  const hashesAfter = await sources();
  const document = {
    ...result,
    moduleLoadedAt,
    sources: hashesBefore,
    sourceTreesUnchangedOnDisk: Object.keys(hashesBefore).every(
      (key) =>
        hashesBefore[key as keyof typeof hashesBefore].sha256 ===
        hashesAfter[key as keyof typeof hashesAfter].sha256,
    ),
  };
  await writeFile(out, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ phase: "scenario-finished", actors: parameters.actors, durationMs: parameters.durationMs, passed: result.passed, measuredWallMs: result.measuredWallMs })}\n`,
  );
  process.exitCode = result.passed ? 0 : 1;
} else {
  if (!args.includes("--run") && !args.includes("--smoke"))
    throw new Error("Explicit --run or --smoke is required; no provider is used.");
  const smoke = args.includes("--smoke");
  const cases: StressParameters[] = smoke
    ? [{ actors: 12, warmupMs: 100, durationMs: 1_000, deltasPerSecond: 20 }]
    : [12, 64, 256]
        .map((actors) => ({ actors, warmupMs: 10_000, durationMs: 60_000, deltasPerSecond: 20 }))
        .concat({ actors: 64, warmupMs: 10_000, durationMs: 300_000, deltasPerSecond: 20 });
  const directory = await mkdtemp(join(tmpdir(), "lcode-workflow-stress-"));
  const scenarios: Record<string, unknown>[] = [];
  const metadata = {
    schemaVersion: 1,
    recordedAt: Date.now(),
    mode: smoke ? "real-wall-clock-smoke" : "real-wall-clock-sustained",
    nodeVersion: process.version,
    configuredNodeVersion: "24.14.0",
    platform: process.platform,
    architecture: process.arch,
    repetitionsPerScenario: 1,
    cpuConvention: "process.cpuUsage / wall; one core = 100 percent",
    buildMode:
      "node --import tsx source driver; pre-existing compiled engine and projection; source shared reducer",
    buildTimeMeaning: "oldest/newest filesystem mtimes, not a claimed reproducible build timestamp",
    environment:
      "Concurrent repository agents, lint/refactor and build activity are not isolated; no existing app/session is touched",
    boundary:
      "Synthetic actor runtime event ports; real driver, engine, in-memory journal, publisher, wire encoder/assembler and shared reducer; no provider or network socket",
    browserMeasuredSeparately: true,
    performanceSloAsserted: false,
    journalRetention:
      "Full real InMemoryJournalStore events retained; their event count/JSON bytes and heap cost are included. Publisher retains the production 2000-entry delta window.",
    ordinaryActivityDefinition:
      "Same kind/request/completed/tool count signature; changed signature classified separately as boundary activity",
    sourceTime:
      "Date.now/new Date at actual emission, preserved by journal envelope and activity; no virtual clock",
    inputScheduling:
      "One real 50ms batch loops over independent actors; overdue batches always yield; achieved rate is measured, not asserted",
    sourceModuleFreeze:
      "Each worker caches modules after import. Disk-directory fingerprints do not prove exact bytes of all loaded transitive modules",
    loadedSourceByteHashVerified: false,
    measurementOverheadIncluded:
      "CPU includes journal cloning, projection JSON byte counting, publisher retention, encode/assemble, schema validation, client reducer and sampling",
    resourceWindow:
      "resources/measuredCounts/projectionWindow cover post-warmup; counts/projection/cleanup cover setup through termination; peaks are sampled",
    transportFlush:
      "continuous >=30ms, replayable >=150ms checked by 50ms source tick; timers may be late under load",
    safetyOnlyPass: true,
  };
  try {
    for (const [index, parameters] of cases.entries()) {
      process.stdout.write(`${JSON.stringify({ phase: "scenario-started", ...parameters })}\n`);
      scenarios.push(await child(parameters, join(directory, `${index}.json`)));
      await writeFile(
        out,
        `${JSON.stringify({ metadata, completed: scenarios.length === cases.length, passed: scenarios.every((scenario) => scenario.passed === true), scenarios }, null, 2)}\n`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  process.exitCode = scenarios.every((scenario) => scenario.passed === true) ? 0 : 1;
}
