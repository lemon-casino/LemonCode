import { refToString, WorkflowError } from "./types.js";
import type { PersonaSpec, RunEvent } from "./types.js";

export function normalizePersona(name: string | undefined, persona: string | PersonaSpec | undefined): PersonaSpec {
  const base: PersonaSpec =
    typeof persona === "string" ? { system: persona } : persona ? { ...persona } : {};
  if (base.name === undefined && name !== undefined) base.name = name;
  return base;
}

export function enrichProviderStopPhase(
  error: WorkflowError,
  instancePhases: ReadonlyMap<string, string>,
): WorkflowError {
  const details = error.providerStop;
  if (details === undefined || details.subagent === undefined || details.phase !== undefined) {
    return error;
  }
  const phase = instancePhases.get(details.subagent);
  if (phase === undefined) return error;
  return new WorkflowError(error.code, error.message, {
    providerStop: { ...details, phase },
    cause: (error as { cause?: unknown }).cause,
  });
}

/** Stamp the birth phase on events that do not have an earlier queued event. */
export function stampBirthPhase(event: RunEvent, phases: ReadonlyMap<string, string>): RunEvent {
  if (event.type === "actor-created") {
    const phaseName = phases.get(refToString(event.actor));
    return phaseName === undefined ? event : { ...event, phaseName };
  }
  if (event.type === "node-queued" || (event.type === "node-settled" && event.cached === true)) {
    const phaseName = phases.get(refToString(event.instance));
    return phaseName === undefined ? event : { ...event, phaseName };
  }
  return event;
}
