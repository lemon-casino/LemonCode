# Lint-Clean Baseline

## Product rule

1. `pnpm lint` must complete with zero errors and zero warnings for the checked-out source tree. New suppressions are not an acceptable substitute for fixing a diagnostic.
2. Lint cleanup is behavior-preserving. Public props, callback signatures and callable arity remain compatible when a value is unused by the current implementation; remove only the local binding unless repository references prove the contract itself is unused.
3. Collection iteration that currently snapshots listeners or work items must keep snapshot semantics. A listener or scope added during the current pass is not visited until the next pass, and removal during a callback does not change the current pass.
4. Concurrent result collection remains input-ordered. Workers may complete out of order, but each result is written to its original input index.
5. Task storage startup keeps the primary operation failure as the authoritative error, including falsy thrown values. Cleanup always attempts every opened resource; a cleanup failure is thrown only when the primary operation succeeded. Failed startup never marks storage prepared or reports ready.
6. Attachment filenames continue rejecting NUL, CR and LF while accepting ordinary names. The validation must express that rule without disabling `no-control-regex`.

## Ownership and boundaries

- Each existing package owns its local cleanup; no state, service or protocol ownership moves between packages.
- Existing public types and package entrypoints remain authoritative. This cleanup does not introduce a second API or a lint-only runtime path.
- Resource cleanup ordering remains owned by task storage startup. RPC listener snapshots remain owned by the existing emitter/server implementations.

## Acceptance

- Repository lint reports zero warnings and zero errors.
- Type checking and `pnpm architecture:check --changed` pass.
- Focused tests cover task-storage primary-versus-close failure precedence and attachment filename validation.
- Existing UI tests and relevant package tests continue to pass.
