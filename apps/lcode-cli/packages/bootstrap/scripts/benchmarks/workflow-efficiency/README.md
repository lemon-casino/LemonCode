# Synthetic workflow efficiency benchmark

This benchmark measures a controlled three-task WorkflowEngine graph plus real provider requests. It does **not** measure the full app, user sessions, UI, tools, or the reliability of prompt decomposition on complex tasks.

## Run from the repository root

Requires the repository's installed dependencies and existing public CLI package `dist` outputs. The script never installs or builds packages. Keep the same Node version and artifacts for all five pairs.

```sh
# Offline tests: no provider requests or configuration writes.
node --import ./apps/lcode-cli/packages/bootstrap/scripts/benchmarks/workflow-efficiency/register.mjs --test ./apps/lcode-cli/packages/bootstrap/scripts/benchmarks/workflow-efficiency/pure.test.ts ./apps/lcode-cli/packages/bootstrap/scripts/benchmarks/workflow-efficiency/driver.test.ts

# Offline configuration, selection, mapping, and artifact-hash preflight.
node ./apps/lcode-cli/packages/bootstrap/scripts/benchmarks/workflow-efficiency/launch.mjs --preflight

# Real provider calls; pair 1 belongs to the final five, not a disposable warm-up.
node ./apps/lcode-cli/packages/bootstrap/scripts/benchmarks/workflow-efficiency/launch.mjs --real --until-pair=1

# Inspect pair 1 acceptance/metrics, then complete BA / AB / BA / AB.
node ./apps/lcode-cli/packages/bootstrap/scripts/benchmarks/workflow-efficiency/launch.mjs --real --resume --until-pair=5
```

The caller must already supply the existing `LCODE_BUILTIN_PROVIDER_CONFIG_FILE` and `LCODE_PERSONAL_PROVIDER_CONFIG_FILE` environment paths. Do not paste credentials or configuration contents into the command line. Configuration is read and decoded in memory; the normal provider adapter owns credential use.

The only persistent benchmark output is `docs/benchmarks/workflow-model-efficiency-2026-10-02.json`. Existing results cannot be overwritten; `--resume` skips already attempted arms, including failures. To collect a separate independent dataset, use a separate checkout without that result file. Do not remove failed samples and rerun them into this dataset.

## Fixed experiment

- Pair order: AB, BA, AB, BA, AB. Arm A is old serial investigation A then B; arm B starts both independent investigations early. Task C always waits for both accepted results.
- Every arm has three identical task prompts/validators within its pair. Prompts are generated from fictional inventory/policy data; integration uses only that arm's validated outputs. Prompt and expected-result hashes are recorded, not their content.
- Model: `new-provider-2/gpt-6-astra`, explicit `max` / `fast`, output cap 5000 per request. Preflight checks the configured maps produce reasoning effort `max` and service tier `priority`; remote enforcement is not independently verified.
- Public `AiSdkModelAdapter` and `WorkflowEngine` dist APIs; the benchmark driver implements the real engine boundary. Only the existing bootstrap governor/ceiling source is imported. No app, AgentRuntime, user session, database, history, title generation, or maintenance is started.
- Each arm uses a fresh process, default production governor ceiling, and empty in-memory journal. No result cache or repair requests. Production workflow retry policy remains unchanged, bounded by a shared 10-minute arm abort plus supervisor cleanup deadline.
- The adapter receives a local environment copy with the existing `LCODE_RUNTIME_ENV=test` setting solely to disable model-I/O diagnostics. User/process settings are not changed. Errors and worker stderr are not copied into results.

## Metrics and limitations

TTFD is the first `node-settled(ok)` **after exact machine validation**, not the first token. Total duration covers engine construction through final validation/settlement; provider setup, hashing, process startup, and cleanup are outside it.

Per-request duration, first text, and output tokens per request-wall second are separate metrics. Adapter attempt duration can include admission/setup. Reasoning tokens are an output subset, never added twice. Missing provider usage fields remain null. Scheduled retry delay is not measured actual sleep; parallel component durations must not be summed into wall time. Tools are disabled, so synthetic tool count/duration is explicitly zero.

All ten measured arms used Node 24.14.1, the same code hashes, and the default 14-slot engine/governor ceiling on this host. Five exploratory pairs cannot establish a stable p95, significance, production SLO, or full-session speedup. Provider load and provider-side caching are not controlled. The recorded second pair has a **slower** early-parallel TTFD (4.116 s versus 4.039 s); it is retained unchanged.
