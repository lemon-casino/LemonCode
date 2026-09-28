// ---------------------------------------------------------------
// Model content protection (generic host vocabulary)
// ---------------------------------------------------------------

/**
 * Host-issued atomicity marker for protected model content. Values are opaque
 * policy identifiers owned by whichever authority verified the tool that
 * produced the content; the generic host pipeline only compares them for
 * equality (registry wiring, budget gates, hook projection). Domain semantics
 * (what the marker protects, how to attest it) live with the owning producer.
 */
export type ModelContentProtection = { kind: string };
