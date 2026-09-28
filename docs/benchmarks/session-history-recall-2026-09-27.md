# Session history recall benchmark evidence — 2026-09-27

## Decision

The bounded production-SQLite search path passes the P3 latency gate. P4 FTS is not activated and no
`0024` CLI migration or tasks-index FTS migration is added.

The feature remains explicitly configurable and default-off. This report closes the engineering
performance gate; it does not authorize an implicit default-on product rollout.

## Command and checkout

Executed from `apps/lcode-cli`:

```text
pnpm bench:session-recall
```

The command built `@lcode/contracts`, `@lcode/adapters`, and `@lcode/core`, created a temporary migrated
SQLite store, seeded the fixed corpus from `specs/session-history-recall-benchmark.md`, ran the shared
automatic-recall search path, closed the store, and removed the temporary directory.

Environment:

- Node: v24.14.1 (repository target: 24.14.0; version mismatch warning recorded)
- OS: Windows (`win32`), x64
- Warm-up calls: 25
- Measured calls: 200
- Corpus: one current session, nine prior sessions, 64 user messages per prior session, two text parts
  per message, five rotating multilingual/identifier queries

## Result

| Metric | Observed   | Gate             | Result |
| ------ | ---------- | ---------------- | ------ |
| cold   | 127.651 ms | observation only | pass   |
| mean   | 57.816 ms  | observation only | pass   |
| p50    | 55.371 ms  | observation only | pass   |
| p95    | 75.113 ms  | ≤150 ms          | pass   |
| p99    | 84.634 ms  | ≤300 ms          | pass   |
| max    | 115.578 ms | observation only | pass   |

All measured calls returned `status: ok`, at least one match, and candidate/session/projection/result
counts within `SESSION_HISTORY_AUTO_RECALL_BOUNDS`. The benchmark reported no invariant failures.

The existing multilingual offline fixture also passed precision@3 ≥0.80 and false-positive-query rate
≤0.10. Exact fixture behavior remains enforced by
`session-history-recall-evaluation.test.ts`; this evidence does not substitute runtime duration
telemetry for future regression detection.
