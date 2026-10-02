# Lint-Clean Baseline

## Product rule

1. `pnpm lint` must complete with zero errors and zero warnings for the checked-out source tree. New suppressions are not an acceptable substitute for fixing a diagnostic.
2. Lint cleanup is behavior-preserving. Public props, callback signatures and callable arity remain compatible when a value is unused by the current implementation; remove only the local binding unless repository references prove the contract itself is unused.
3. Collection iteration that currently snapshots listeners or work items must keep snapshot semantics. A listener or scope added during the current pass is not visited until the next pass, and removal during a callback does not change the current pass.
4. Concurrent result collection remains input-ordered. Workers may complete out of order, but each result is written to its original input index.
5. Task storage startup keeps the primary operation failure as the authoritative error, including falsy thrown values. Cleanup always attempts every opened resource; a cleanup failure is thrown only when the primary operation succeeded. Failed startup never marks storage prepared or reports ready.
6. Attachment filenames continue rejecting NUL, CR and LF while accepting ordinary names. The validation must express that rule without disabling `no-control-regex`.
7. The CLI workspace is part of this requirement: `pnpm --dir apps/lcode-cli lint` must also report zero warnings and zero errors. Keep the existing package scopes, 400-line rule and warning categories; do not move source outside lint inputs, raise thresholds, add ignores/disable directives, minify statements, or delete required behavior to make the check pass.
8. Split oversized modules by coherent responsibility and preserve existing public entrypoints through explicit re-exports. Stateful classes retain one owner; extracted execution helpers borrow that owner's state through narrow types rather than keeping a parallel cache, queue, connection or cleanup path.
9. Preserve all pre-existing local feature changes. Type, schema, protocol, event order, default values, side-effect timing and fail-closed guards remain unchanged; any actual behavior defect discovered during cleanup gets a specific regression and a documented semantic correction.

### CLI adapter cleanup (rules 7–9)

- Scope: `adapters/src/{storage,config,fs,browser,skills}/**`; public entrypoints, callable arity, defaults, persisted serialization, SQL text, historical migration versions and transaction/lock ordering remain unchanged. Oversized definitions and migration lists may move to responsibility-specific modules while keeping their original order.
- Existing adapter instances remain the only owners of filesystem caches, browser sessions, loaded skills/configuration and SQLite connections. Extracted operations borrow the owner or immutable inputs; they do not create parallel caches, session tables or accepted state.
- Migration cleanup preserves the original operation failure even when its thrown value is `null`, `undefined` or `0`. Closing the migration generator and restoring the connection's busy timeout are independent cleanup attempts, so one cleanup failure cannot skip the other; cleanup failure is surfaced only after primary success. The startup factory still closes a failed connection and never returns it to callers. Regressions cover falsy notification failures, rollback, timeout restoration, simultaneous primary/cleanup failure, and successful retry on a new startup connection.
- Cleanup/refactoring preserves snapshot iteration (`Array.from` or an equivalent snapshot), security/path validation, cancellation, discovery priority, configuration precedence and file atomic-write semantics.

```text
adapter caller → existing adapter/state owner → existing operation/repository → result
SQLite startup → open connection → inspect → begin immediate → migrations → commit → return store
                 on failure: close generator/rollback → restore busy timeout → close failed connection
                 primary failure takes precedence; each cleanup is attempted before rejection
```

- Acceptance for this bounded batch: all five adapter directories lint with zero warnings/errors; focused filesystem/configuration/storage/browser/skills checks exercise moved responsibilities and migration failure precedence. The coordinating agent runs repository/CLI type checking and full lint after all parallel writers finish; this batch does not build shared `dist` outputs.

## Ownership and boundaries

- Each existing package owns its local cleanup; no state, service or protocol ownership moves between packages.
- Existing public types and package entrypoints remain authoritative. This cleanup does not introduce a second API or a lint-only runtime path.
- Resource cleanup ordering remains owned by task storage startup. RPC listener snapshots remain owned by the existing emitter/server implementations.

## Acceptance

- Repository lint reports zero warnings and zero errors.
- Type checking and `pnpm architecture:check --changed` pass.
- Focused tests cover task-storage primary-versus-close failure precedence and attachment filename validation.
- Existing UI tests and relevant package tests continue to pass.

## CLI cleanup validation (2026-10-02)

- Starting CLI diagnostics: 87 errors / 54 warnings using the existing package lint scripts. After cleanup, a forced run of all 14 available lint tasks reported zero warnings and zero errors; no lint scope, threshold or suppression was relaxed.
- Full CLI type checking and required dependency builds passed 27/27 tasks with zero cache hits after fixing the integration-discovered fixture and declaration errors. Root type checking and lint passed, and architecture violations/baseline/new were all zero.
- The rebuilt public declaration entrypoints retained all 4,933 baseline export names across 48 entries. This is an export-name presence check, not a substitute for signature and behavior regressions.
- Unified offline CLI regression passed 722 unique cases across 155 files. The first attempt's three debug JSX failures remain recorded; selecting that package's existing `react-jsx` tsconfig corrected the test launcher without a source workaround. Shared 17, UI 58, Web 62 and bundled-plugin 26 cases also passed with no skips. Six subsequent AST-equivalent formatting fixes passed an additional 66-case seam run, not added again to the unique total.
- Unified regression results and bounded change accounting are recorded in `docs/benchmarks/workflow-efficiency-2026-10-02.md` with the benchmark results. Existing unrelated workspace changes were retained.
- At this cleanup checkpoint, the extra `registry:check` still failed for a confirmed pre-existing Windows path-hash/CRLF mismatch with an otherwise identical generated registry body. The later user-authorized repair below supersedes that remaining-failure status without erasing the original result.

## Follow-up performance and failure repair (2026-10-02)

- The registry generator now normalizes hash paths to POSIX and compares checkout text with only CRLF normalized. Its 17 regressions and actual `registry:check` pass; the generated registry's original bytes/hash were not rewritten.
- Debug now has a persistent package test command using its existing JSX tsconfig and a CLI `test:debug` entry; 9 cases pass without a temporary environment workaround.
- Follow-up validation covers 233 unique files / 1,201 unique cases, including 996 CLI cases from the current checkout. The initial Web Popover timeout, one unchanged isolated retry, and the later synchronization-fix verification remain separate attempts rather than increasing the unique count.
- Final root typecheck/lint, CLI forced typecheck/lint, architecture and scoped formatting/diff checks pass. The exact source and performance boundaries, including a retained narrow-screen long-frame anomaly, are documented in `docs/benchmarks/workflow-performance-repair-2026-10-02.md`.
