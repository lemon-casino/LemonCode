import { parseArgs } from "node:util";
import { runSuite } from "./benchmarks/task-quality/harness.mjs";

const { values } = parseArgs({
  options: {
    real: { type: "boolean" },
    cli: { type: "string" },
    config: { type: "string" },
    output: { type: "string" },
    experiment: { type: "string" },
    "timeout-ms": { type: "string" },
    "max-output-bytes": { type: "string" },
    "max-requests": { type: "string" },
    "max-arm-tokens": { type: "string" },
    "max-total-tokens": { type: "string" },
    "pass-env": { type: "string", multiple: true },
    help: { type: "boolean" },
  },
});
if (values.help) {
  process.stdout.write(
    "Offline: node task-quality-benchmark.mjs --output <dir>\nReal: add --real --cli <built-cli.cjs> --config <synthetic-config.json> --experiment goal|workflow|memory --timeout-ms N --max-output-bytes N --max-requests N --max-arm-tokens N --max-total-tokens N\n",
  );
} else {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const number = (key) => (values[key] === undefined ? undefined : Number(values[key]));
    const report = await runSuite({
      real: values.real,
      cli: values.cli,
      config: values.config,
      output: values.output,
      experiment: values.experiment,
      timeoutMs: number("timeout-ms"),
      maxOutputBytes: number("max-output-bytes"),
      maxRequests: number("max-requests"),
      maxArmTokens: number("max-arm-tokens"),
      maxTotalTokens: number("max-total-tokens"),
      passEnv: values["pass-env"],
      signal: controller.signal,
    });
    process.stdout.write(
      JSON.stringify({
        real: report.real,
        complete: report.complete,
        stopReason: report.stopReason,
        summary: report.summary,
      }) + "\n",
    );
    if (!report.complete || report.results.some((r) => r.status !== "passed")) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
