try {
  await import("./register.mjs");
  const { main } = await import("./run.ts");
  await main(process.argv.slice(2));
} catch (error) {
  const allowed = new Set([
    "arguments_invalid",
    "real_calls_require_explicit_flag",
    "existing_results_require_resume",
    "benchmark_settings_changed",
    "preflight_failed",
    "worker_result_missing",
  ]);
  const reason =
    error instanceof Error && allowed.has(error.message) ? error.message : "benchmark_setup_failed";
  process.stderr.write(`${JSON.stringify({ status: "failed", reason })}\n`);
  process.exitCode = 1;
}
