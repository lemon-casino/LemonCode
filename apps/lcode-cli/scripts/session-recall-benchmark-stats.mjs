export function nearestRank(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new RangeError("values must contain at least one duration");
  }
  if (!Number.isFinite(percentile) || percentile < 0 || percentile > 1) {
    throw new RangeError("percentile must be between zero and one");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1));
  return sorted[index];
}

export function summarizeDurations(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new RangeError("values must contain at least one duration");
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    minMs: round(Math.min(...values)),
    meanMs: round(total / values.length),
    p50Ms: round(nearestRank(values, 0.5)),
    p95Ms: round(nearestRank(values, 0.95)),
    p99Ms: round(nearestRank(values, 0.99)),
    maxMs: round(Math.max(...values)),
  };
}

export function evaluateSessionRecallBenchmark({ durations, invariantFailures, thresholds }) {
  const latency = summarizeDurations(durations);
  const failures = [...invariantFailures];
  if (latency.p95Ms > thresholds.p95Ms) failures.push("p95_threshold_exceeded");
  if (latency.p99Ms > thresholds.p99Ms) failures.push("p99_threshold_exceeded");
  return {
    failures: [...new Set(failures)],
    latency,
    passed: failures.length === 0,
  };
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}
