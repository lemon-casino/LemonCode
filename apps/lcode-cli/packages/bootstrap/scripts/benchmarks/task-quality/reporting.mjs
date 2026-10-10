export function summarize(results) {
  return [...new Set(results.map((r) => r.arm))].map((arm) => {
    const rows = results.filter((r) => r.arm === arm),
      times = rows.map((r) => r.durationMs).sort((a, b) => a - b);
    return {
      arm,
      samples: rows.length,
      passed: rows.filter((r) => r.status === "passed").length,
      successRate: rows.filter((r) => r.status === "passed").length / rows.length,
      medianMs:
        times.length % 2
          ? times[Math.floor(times.length / 2)]
          : (times[times.length / 2 - 1] + times[times.length / 2]) / 2,
      minMs: times[0],
      maxMs: times.at(-1),
      totalTokens: rows.every((r) => r.usage.totalTokens !== null)
        ? rows.reduce((s, r) => s + r.usage.totalTokens, 0)
        : null,
    };
  });
}
export function pairedComparisons(
  results,
  arms,
  taskIds = [...new Set(results.map((row) => row.taskId))],
) {
  const output = [];
  for (const candidate of arms.slice(1)) {
    const pairs = [];
    for (const taskId of taskIds) {
      const baseline = results.find((row) => row.taskId === taskId && row.arm === arms[0]);
      const comparison = results.find((row) => row.taskId === taskId && row.arm === candidate);
      let excludedReason;
      if (!baseline || !comparison) excludedReason = "missing-arm";
      else if (baseline.status !== "passed" || comparison.status !== "passed")
        excludedReason = "failed-arm";
      else if (baseline.treatment?.applied !== true || comparison.treatment?.applied !== true)
        excludedReason = "treatment-unverified";
      else if (
        baseline.selection?.coverage !== "complete" ||
        comparison.selection?.coverage !== "complete"
      )
        excludedReason = "selection-unverified";
      else if (
        JSON.stringify(baseline.selection.selections) !==
        JSON.stringify(comparison.selection.selections)
      )
        excludedReason = "selection-mismatch";
      else if (
        !Number.isFinite(baseline.durationMs) ||
        !Number.isFinite(comparison.durationMs) ||
        baseline.durationMs <= 0 ||
        comparison.durationMs <= 0
      )
        excludedReason = "duration-invalid";
      pairs.push({
        taskId,
        excludedReason: excludedReason ?? null,
        durationRatio: excludedReason ? null : baseline.durationMs / comparison.durationMs,
      });
    }
    const ratios = pairs
      .filter((pair) => pair.excludedReason === null && Number.isFinite(pair.durationRatio))
      .map((pair) => pair.durationRatio)
      .sort((a, b) => a - b);
    output.push({
      baseline: arms[0],
      candidate,
      pairs,
      eligiblePairs: ratios.length,
      medianDurationRatio: ratios.length
        ? ratios.length % 2
          ? ratios[Math.floor(ratios.length / 2)]
          : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2
        : null,
    });
  }
  return output;
}
export function renderReport(report) {
  return `# Task quality benchmark\n\nMode: ${report.real ? "real model" : "offline fake CLI; harness validation only"}\n\nPlan: ${report.executedSamples}/${report.plannedSamples} samples; ${report.complete ? "complete" : `incomplete (${report.stopReason ?? "unknown"})`}.\n\nFixture: ${report.fixtureVersion}\n\n| Arm | Samples | Passed | Median ms | Range ms | Tokens |\n| --- | ---: | ---: | ---: | --- | ---: |\n${report.summary.map((r) => `| ${r.arm} | ${r.samples} | ${r.passed} | ${r.medianMs} | ${r.minMs}–${r.maxMs} | ${r.totalTokens ?? "unknown"} |`).join("\n")}\n\n| Verified pair | Eligible pairs | Median duration ratio |\n| --- | ---: | ---: |\n${report.comparisons.map((pair) => `| ${pair.baseline} / ${pair.candidate} | ${pair.eligiblePairs} | ${pair.medianDurationRatio ?? "unverified"} |`).join("\n")}\n\nTreatment or selection not verified, failed, and missing arms are excluded from ratios and retained with reasons in report.json. All failures remain in results.ndjson. No production benefit or statistical significance is inferred.\n`;
}
