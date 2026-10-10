import { join } from "node:path";

/** The supplied evaluation model configuration is retained; executable extensions and persistence are fixed. */
export function createArmConfig(config, storage, experiment, arm) {
  const result = structuredClone(config);
  result.storage = { dir: storage, sessionDbPath: join(storage, "cli", "sessions.sqlite") };
  result.features = {
    ...result.features,
    skill: false,
    mcp: false,
    memory: experiment === "memory",
  };
  result.plugins = {
    enabled: false,
    dirs: [],
    enabledPlugins: {},
    options: {},
    extraKnownMarketplaces: [],
    suppressedBuiltins: [],
  };
  result.mcp = { servers: {} };
  result.skills = { enabled: false, includeInstructions: false, roots: [] };
  result.hooks = { enabled: false, events: {} };
  result.sessionRecall = { enabled: false };
  result.memory = {
    use: experiment === "memory" && arm !== "off",
    observationEnabled: experiment === "memory",
    rankingExperimentEnabled: false,
  };
  return result;
}

export function createArmEnvironment(
  home,
  storage,
  passEnv = [],
  source = process.env,
  fakeMode = "success",
) {
  const env = {};
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    ...passEnv,
  ])
    if (source[key] !== undefined) env[key] = source[key];
  // Explicit benchmark-owned values override even accidentally passed production variables.
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    LCODE_STORAGE_DIR: storage,
    LCODE_SESSION_DB_PATH: join(storage, "cli", "sessions.sqlite"),
    LCODE_SESSION_DB: join(storage, "cli", "sessions.sqlite"),
    LCODE_DATA_BASE_DIR: home,
    LCODE_RUNTIME_ENV: "test",
    LCODE_MODEL_TELEMETRY_ENABLED: "false",
    LCODE_BENCH_FAKE_MODE: fakeMode,
  };
}

export function treatmentEvidence(experiment, arm, result, records) {
  if (experiment === "goal") {
    const goal = result.benchmarkTreatment?.goal;
    return {
      applied: goal ? goal.policy === arm && (arm !== "strict" || goal.requirementCount > 0) : null,
      completed: goal?.status === "complete",
      source: goal ? "persisted-goal" : "unavailable",
    };
  }
  if (experiment === "workflow") {
    const workflow = records.some(
      (record) =>
        record?.type === "workflow.run.progress" &&
        typeof record.payload?.runId === "string" &&
        record.payload.eventType === "run-started",
    );
    const actors = result.physicalRequests?.requests?.some((request) => request.kind === "actor");
    return {
      applied:
        arm === "workflow"
          ? workflow
          : arm === "single"
            ? !workflow && (actors === undefined ? null : !actors)
            : null,
      source: "workflow-progress-and-request-facts",
    };
  }
  // Config and a seed file establish assignment, not actual model-visible injection.
  return {
    applied: null,
    source: experiment === "memory" ? "injection-unobserved" : "offline-harness",
  };
}

export function memoryTreatmentEvidence(arm, snapshot, summary) {
  const requests = summary?.requests;
  const maintenanceRequests =
    Array.isArray(requests) && requests.some((request) => request?.startedAt)
      ? requests.filter((request) => request?.kind === "memory" && request.startedAt).length
      : null;
  return {
    applied:
      maintenanceRequests === null
        ? null
        : (arm === "off" ? snapshot.injectedEntries === 0 : snapshot.injectedEntries > 0) &&
          (arm === "maintenance" ? maintenanceRequests > 0 : maintenanceRequests === 0),
    source: "isolated-L0-ledger-and-physical-requests",
    observedTurns: snapshot.turnCount,
    injectedEntries: snapshot.injectedEntries,
    versionedEntries: snapshot.versionedEntries,
    maintenanceRequests,
  };
}

export function observedSelections(summary) {
  const requests = summary?.requests;
  if (!Array.isArray(requests) || requests.length === 0)
    return { coverage: "incomplete", selections: [] };
  const selections = requests
    .filter((request) => request.kind === "main" || request.kind === "actor")
    .map((request) => ({
      providerId: request.providerId ?? null,
      modelId: request.modelId ?? null,
      selectedSpeed: request.selectedSpeed,
      effectiveReasoningState: request.effectiveReasoningState ?? null,
      effectiveReasoningControl: request.effectiveReasoningControl ?? null,
      effectiveReasoningLevel: request.effectiveReasoningLevel ?? null,
      effectiveReasoningBudgetTokens: request.effectiveReasoningBudgetTokens ?? null,
    }));
  const unique = [
    ...new Map(selections.map((selection) => [JSON.stringify(selection), selection])).values(),
  ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return {
    coverage:
      selections.length > 0 &&
      selections.every(
        (selection) =>
          selection.providerId &&
          selection.modelId &&
          (selection.selectedSpeed === null || typeof selection.selectedSpeed === "string"),
      )
        ? "complete"
        : "incomplete",
    selections: unique,
  };
}
