import type { AuthModel } from "../driver.js";
import { catalogMetadata, reasoningVariants } from "./catalog-metadata.js";
import { record, type Json } from "./common.js";

export function googleMetadata(
  id: string,
  channel: "gemini" | "antigravity",
  catalog: Json,
): Partial<AuthModel> {
  const publicModels = record(record(catalog.google).models);
  const raw = record(publicModels[id] || publicModels[id.replace(/-preview$/u, "")]);
  const found = catalogMetadata(raw);
  // AG每个模型的窗口以上游目录为准，不能借Anthropic直连的1M覆盖AG的250k。
  if (channel === "antigravity") {
    delete found.contextWindow;
    delete found.maxOutputTokens;
  }
  if (/^gemini-(?:3|pro-agent)/u.test(id))
    return {
      ...found,
      reasoning: true,
      reasoningVariants: reasoningVariants(
        id.includes("flash") ? ["low", "medium", "high"] : ["low", "high"],
      ),
    };
  if (id.startsWith("gemini-2.5"))
    return {
      ...found,
      reasoning: true,
      reasoningVariants: reasoningVariants(
        id.includes("pro") ? ["low", "medium", "high"] : ["off", "low", "medium", "high"],
        true,
      ),
    };
  if (id.includes("claude") && id.includes("thinking"))
    return {
      ...found,
      reasoning: true,
      reasoningVariants: reasoningVariants(["low", "medium", "high"], true),
    };
  return found;
}

const rank = ["minimal", "low", "medium", "high", "xhigh"];
const split = (id: string): [string, string] => {
  const m = /^(.+)-(extra-high|extra-low|xhigh|minimal|low|medium|high)$/u.exec(id);
  return m
    ? [m[1]!, m[2] === "extra-high" ? "xhigh" : m[2] === "extra-low" ? "minimal" : m[2]!]
    : [id, ""];
};
const named = (name: string) =>
  / \((minimal|extra low|low|medium|high|extra high|xhigh)\)$/iu
    .exec(name)?.[1]
    ?.toLowerCase()
    .replace("extra low", "minimal")
    .replace("extra high", "xhigh") || "";

export function collapseGoogleModels(models: readonly AuthModel[]): {
  models: AuthModel[];
  wire: Map<string, Map<string, string>>;
} {
  const groups = new Map<string, AuthModel[]>();
  for (const m of models) {
    const [family] = split(m.id);
    groups.set(family, [...(groups.get(family) || []), m]);
  }
  const wire = new Map<string, Map<string, string>>(),
    out: AuthModel[] = [];
  for (const [id, rows] of groups) {
    if (rows.length === 1) {
      out.push(rows[0]!);
      continue;
    }
    const names = rows.map((m) => named(m.name));
    const allNamed = names.every(Boolean) && new Set(names).size === rows.length;
    const lookup = new Map(rows.map((m, i) => [allNamed ? names[i]! : split(m.id)[1], m.id]));
    const defaultID =
      lookup.get("") ||
      lookup.get("high") ||
      [...rank]
        .reverse()
        .map((e) => lookup.get(e))
        .find(Boolean) ||
      rows[0]!.id;
    lookup.set("", defaultID);
    wire.set(id, lookup);
    const base = rows.find((m) => m.id === defaultID)!;
    const least = (key: "contextWindow" | "maxOutputTokens") => {
      const values = rows
        .map((m) => m[key])
        .filter((v): v is number => typeof v === "number" && v > 0);
      return values.length ? Math.min(...values) : undefined;
    };
    const efforts = rank.filter((level) => lookup.has(level));
    out.push({
      ...base,
      id,
      name: base.name.replace(/ \([^)]+\)$/u, ""),
      contextWindow: least("contextWindow"),
      maxOutputTokens: least("maxOutputTokens"),
      images: rows.every((m) => m.images),
      reasoning: efforts.length > 0,
      reasoningVariants: reasoningVariants(efforts),
    });
  }
  for (const m of out) {
    if (m.id.endsWith("-tiered")) {
      const base = out.find((v) => v.id === m.id.slice(0, -7));
      if (base) {
        m.reasoningVariants = base.reasoningVariants;
        m.reasoning = base.reasoning;
        if (m.name === m.id) m.name = base.name + " (Tiered)";
      }
    }
  }
  return { models: out, wire };
}
