import { createHash } from "node:crypto";

export const BENCHMARK_VERSION = 1;
export const ARM_TIMEOUT_MS = 10 * 60_000;
export const CLEANUP_TIMEOUT_MS = 5_000;
export const OUTPUT_CAP = 5_000;
export const PAIR_ORDERS = ["AB", "BA", "AB", "BA", "AB"] as const;
export const SELECTION = {
  providerId: "new-provider-2",
  modelId: "gpt-6-astra",
  options: { reasoningLevel: "max", speed: "fast" },
} as const;
export const TASK_IDS = ["A", "B", "C"] as const;
export type TaskId = (typeof TASK_IDS)[number];
export type Arm = "A" | "B";
export interface InventoryResult {
  task: "A";
  rows: { id: string; available: number }[];
}
export interface PolicyResult {
  task: "B";
  eligible: string[];
}
export interface IntegrationResult {
  task: "C";
  candidates: string[];
  totalAvailable: number;
  chosen: string | null;
}
export type TaskResult = InventoryResult | PolicyResult | IntegrationResult;
export interface Fixture {
  pair: number;
  threshold: number;
  prompts: Record<"A" | "B", string>;
  expected: Record<TaskId, TaskResult>;
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

const OUTPUT_RULE =
  "Return exactly one JSON object, no markdown, no explanation, no extra keys. " +
  "Use only the fictional input below. Do not use tools or outside knowledge.";

export function makeFixture(pair: number): Fixture {
  if (!Number.isInteger(pair) || pair < 1 || pair > PAIR_ORDERS.length)
    throw new Error("fixture_id_invalid");
  const rows: InventoryResult["rows"] = [];
  const inventory = [];
  const policies = [];
  const eligible: string[] = [];
  for (let index = 1; index <= 8; index += 1) {
    const id = `I${index}`;
    const stock = 11 + ((index * 7 + pair * 3) % 29);
    const reserved = (index * 3 + pair) % 12;
    rows.push({ id, available: Math.max(0, stock - reserved) });
    inventory.push(
      { id, revision: 2, stock, reserved },
      { id, revision: 1, stock: stock + 9, reserved: reserved + 2 },
    );
    const enabled = index !== ((pair + 1) % 8) + 1;
    const certified = index !== ((pair + 3) % 8) + 1;
    const risk = (index + pair) % 4;
    const regions = index % 3 === 0 ? ["R2"] : ["R1", "R2"];
    policies.push({ id, enabled, certified, risk, regions });
    if (enabled && certified && risk <= 2 && regions.includes("R1")) eligible.push(id);
  }
  const a: InventoryResult = { task: "A", rows };
  const b: PolicyResult = { task: "B", eligible };
  const threshold = 12 + pair;
  return {
    pair,
    threshold,
    prompts: {
      A: [
        `Synthetic experiment ${pair}; task A: investigate an inventory revision ledger.`,
        "For each id choose only its highest revision; do not add revisions together. " +
          "available = max(0, stock - reserved). Include all ids, sorted lexicographically.",
        'Required shape: {"task":"A","rows":[{"id":"I1","available":0},...]}.',
        OUTPUT_RULE,
        `Inventory=${JSON.stringify(inventory.reverse())}`,
      ].join("\n"),
      B: [
        `Synthetic experiment ${pair}; task B: independently investigate shipping policy.`,
        "An id is eligible exactly when enabled=true AND certified=true AND risk<=2 " +
          'AND regions contains "R1". Return eligible ids sorted lexicographically.',
        'Required shape: {"task":"B","eligible":["I1",...]}.',
        OUTPUT_RULE,
        `Policies=${JSON.stringify(policies.reverse())}`,
      ].join("\n"),
    },
    expected: { A: a, B: b, C: integrate(a, b, threshold) },
  };
}

function integrate(a: InventoryResult, b: PolicyResult, threshold: number): IntegrationResult {
  const candidates = a.rows.filter(
    (row) => b.eligible.includes(row.id) && row.available >= threshold,
  );
  const ranked = [...candidates].sort(
    (left, right) => right.available - left.available || left.id.localeCompare(right.id, "en"),
  );
  return {
    task: "C",
    candidates: candidates.map((row) => row.id),
    totalAvailable: candidates.reduce((sum, row) => sum + row.available, 0),
    chosen: ranked[0]?.id ?? null,
  };
}

export function validResult(fixture: Fixture, task: TaskId, value: unknown): boolean {
  return canonical(value) === canonical(fixture.expected[task]);
}

export function integrationPrompt(fixture: Fixture, a: unknown, b: unknown): string {
  // 修复依据：依赖必须来自本臂已经验收的输出，不能拿 fixture 答案或另一臂缓存代替交付。
  if (!validResult(fixture, "A", a) || !validResult(fixture, "B", b))
    throw new Error("dependency_validation_failed");
  return [
    `Synthetic experiment ${fixture.pair}; task C: integrate the two validated investigations.`,
    `Select ids present in policy.eligible whose inventory available >= ${fixture.threshold}.`,
    "candidates must be sorted lexicographically; totalAvailable sums their available values. " +
      "chosen is the candidate with greatest available, breaking ties by lexicographically " +
      "smallest id; if none, candidates=[], totalAvailable=0, chosen=null.",
    'Required shape: {"task":"C","candidates":["I1",...],"totalAvailable":0,"chosen":"I1"}.',
    OUTPUT_RULE,
    `inventory=${canonical(a)}`,
    `policy=${canonical(b)}`,
  ].join("\n");
}

export interface ThreeTaskHost {
  ask(task: TaskId, prompt: string): Promise<unknown>;
}

export async function oldSerial(host: ThreeTaskHost, fixture: Fixture): Promise<unknown> {
  const a = await host.ask("A", fixture.prompts.A);
  const b = await host.ask("B", fixture.prompts.B);
  return host.ask("C", integrationPrompt(fixture, a, b));
}

export async function newEarlyParallel(host: ThreeTaskHost, fixture: Fixture): Promise<unknown> {
  const a = host.ask("A", fixture.prompts.A);
  const b = host.ask("B", fixture.prompts.B);
  const [acceptedA, acceptedB] = await Promise.all([a, b]);
  return host.ask("C", integrationPrompt(fixture, acceptedA, acceptedB));
}

export function fixtureFingerprints(fixture: Fixture) {
  const prompts = {
    ...fixture.prompts,
    C: integrationPrompt(fixture, fixture.expected.A, fixture.expected.B),
  };
  return TASK_IDS.map((task) => ({
    task,
    promptSha256: sha256(prompts[task]),
    expectedSha256: sha256(canonical(fixture.expected[task])),
  }));
}
