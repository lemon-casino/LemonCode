export interface SourceInputs {
  projectId: string;
  logDir: string;
  eventPath: string;
  dbPath: string;
  sessionId: string;
}

export const emptyInputs: SourceInputs = {
  projectId: "",
  logDir: "",
  eventPath: "",
  dbPath: "",
  sessionId: "",
};

export const lastProjectStorageKey = "lcode-debug:last-project-id";

export type DebugView = "trace" | "gantt" | "network";

export const viewLabels: Record<DebugView, string> = {
  trace: "Trace",
  gantt: "甘特图",
  network: "网络请求",
};

export function buildQuery(inputs: SourceInputs): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(inputs)) {
    if (value.trim()) params.set(key, value.trim());
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function viewFromHash(hash: string): DebugView {
  const normalized = hash.replace(/^#/, "");
  if (normalized === "gantt" || normalized === "network") return normalized;
  return "gantt";
}
