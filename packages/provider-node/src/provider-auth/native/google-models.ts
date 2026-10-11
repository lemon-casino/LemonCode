import type { AuthGrant, AuthModel } from "../driver.js";
import {
  joinedSignal,
  list,
  record,
  text,
  number,
  wait,
  type Json,
  type Fetcher,
} from "./common.js";
import { PublicCatalog } from "./catalog-metadata.js";
import { collapseGoogleModels, googleMetadata } from "./google-capabilities.js";
type Channel = "gemini" | "antigravity";
type Call = (method: string, body: Json, signal: AbortSignal, base?: string) => Promise<Json>;
type AccountCall = (
  grant: AuthGrant,
  method: string,
  body: Json,
  signal: AbortSignal,
) => Promise<Json>;
const platforms: Record<string, string> = {
  "win32-x64": "WINDOWS_AMD64",
  "darwin-arm64": "DARWIN_ARM64",
  "darwin-x64": "DARWIN_AMD64",
  "linux-x64": "LINUX_AMD64",
  "linux-arm64": "LINUX_ARM64",
};
const PROD = "https://cloudcode-pa.googleapis.com";
const definitions = [
  ["gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview"],
  ["gemini-3-pro-preview", "Gemini 3 Pro Preview"],
  ["gemini-3-flash-preview", "Gemini 3 Flash Preview"],
  ["gemini-3.8-flash", "Gemini 3.8 Flash"],
  ["gemini-3.5-flash", "Gemini 3.5 Flash"],
  ["gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite"],
  ["gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite"],
  ["gemini-2.5-pro", "Gemini 2.5 Pro"],
  ["gemini-2.5-flash", "Gemini 2.5 Flash"],
  ["gemini-2.5-flash-lite", "Gemini 2.5 Flash Lite"],
] as const;
const agFallback = [
  ["gemini-pro-agent", "Gemini 3.1 Pro (High)"],
  ["gemini-3.1-pro-low", "Gemini 3.1 Pro (Low)"],
  ["gemini-3-flash", "Gemini 3 Flash"],
  ["gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite"],
  ["claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)"],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6"],
  ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
] as const;
export async function resolveGoogleProject(
  grant: AuthGrant,
  channel: Channel,
  call: Call,
  signal: AbortSignal,
): Promise<AuthGrant> {
  const ag = channel === "antigravity",
    want = text(grant.projectId);
  const metadata: Json = ag
    ? { ideType: "ANTIGRAVITY" }
    : {
        ideType: "IDE_UNSPECIFIED",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
        ...(want ? { duetProject: want } : {}),
      };
  let load: Json;
  try {
    load = await call(
      "loadCodeAssist",
      { metadata, ...(want && !ag ? { cloudaicompanionProject: want } : {}) },
      signal,
      PROD,
    );
  } catch (error) {
    signal.throwIfAborted();
    if (ag && want) return { ...grant, projectReady: true, tier: undefined, paidTier: undefined };
    throw error;
  }
  const projectOf = (value: unknown) => text(value) || text(record(value).id);
  const current = record(load.currentTier),
    paid = record(load.paidTier);
  let project = ag && want ? want : projectOf(load.cloudaicompanionProject);
  let plan = text(paid.name) || text(current.name),
    tier = text(current.id);
  if (!ag && load.currentTier) {
    project ||= want;
    if (!project) throw new Error("This Code Assist plan requires a Google Cloud project ID");
  }
  if ((!ag && !load.currentTier) || (!project && ag)) {
    const tiers = list(load.allowedTiers).map(record),
      selected = tiers.find((t) => t.isDefault === true) || tiers[0] || {};
    tier = text(selected.id) || "free-tier";
    if (ag && tier === "legacy-tier") tier = "free-tier";
    if (!ag && selected.userDefinedCloudaicompanionProject === true && !want)
      throw new Error("This Code Assist plan requires a Google Cloud project ID");
    const body = ag
      ? {
          tier_id: tier,
          metadata: { ide_type: "ANTIGRAVITY", ide_name: "antigravity", ide_version: "1.20.6" },
        }
      : {
          tierId: tier,
          metadata,
          ...(tier !== "free-tier" && want ? { cloudaicompanionProject: want } : {}),
        };
    const bounded = joinedSignal(signal, AbortSignal.timeout(30_000));
    for (let attempt = 0; attempt < 15; attempt++) {
      const result = await call("onboardUser", body, bounded, ag ? undefined : PROD);
      if (result.done === true) {
        project = projectOf(record(result.response).cloudaicompanionProject) || (!ag ? want : "");
        break;
      }
      await wait(2000, bounded);
    }
    plan ||= text(selected.name);
  }
  if (!project)
    throw new Error(
      "Google has not provisioned Code Assist for this account; supply a project or finish setup in its app",
    );
  return { ...grant, projectId: project, projectReady: true, tier, paidTier: text(paid.id), plan };
}

export class GoogleModels {
  private experiments?: { key: string; at: number; flags: Map<number, boolean> };
  private readonly metadata: PublicCatalog;
  private variants = new Map<string, Map<string, string>>();
  private loaded = false;
  fellBack = false;
  constructor(
    private readonly channel: Channel,
    private readonly call: AccountCall,
    request?: Fetcher,
  ) {
    this.metadata = new PublicCatalog(request);
  }
  private get baseURL() {
    return (
      (this.channel === "antigravity" ? "https://daily-cloudcode-pa.googleapis.com" : PROD) + "/v1"
    );
  }
  private async flags(grant: AuthGrant, signal: AbortSignal): Promise<Map<number, boolean>> {
    const key = text(grant.refresh) + "\0" + text(grant.projectId);
    if (this.experiments?.key === key && Date.now() - this.experiments.at < 3600000)
      return this.experiments.flags;
    let flags = new Map<number, boolean>();
    try {
      const response = await this.call(
        grant,
        "listExperiments",
        {
          project: grant.projectId,
          metadata: {
            ideName: "IDE_UNSPECIFIED",
            pluginType: "GEMINI",
            ideVersion: "0.61.0",
            platform: platforms[`${process.platform}-${process.arch}`] || "PLATFORM_UNSPECIFIED",
            updateChannel: "stable",
            duetProject: grant.projectId,
          },
        },
        signal,
      );
      flags = new Map(
        list(response.flags).map((value) => {
          const flag = record(value);
          return [Number(flag.flagId), flag.boolValue === true];
        }),
      );
    } catch {
      signal.throwIfAborted();
    }
    this.experiments = { key, at: Date.now(), flags };
    return flags;
  }
  private shown(id: string, flags: Map<number, boolean>): string {
    if (["gemini-3-flash", "gemini-3.5-flash", "gemini-3.8-flash"].includes(id))
      return flags.get(45842815) ? "gemini-3.8-flash" : "gemini-3.5-flash";
    if (["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"].includes(id))
      return flags.get(45827489) ? "gemini-3.5-flash-lite" : "gemini-3.1-flash-lite";
    return id;
  }
  async wire(grant: AuthGrant, model: string, signal: AbortSignal, effort = ""): Promise<string> {
    if (this.channel === "antigravity") {
      if (!this.loaded) await this.models(grant, signal);
      const variants = this.variants.get(model);
      return variants?.get(effort) || variants?.get("") || model;
    }
    const f = await this.flags(grant, signal);
    if (["gemini-3.5-flash", "gemini-3-flash", "gemini-3.8-flash"].includes(model))
      return f.get(45842815) ? "gemini-3.8-flash" : "gemini-3-flash";
    if (["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"].includes(model))
      return f.get(45827489) ? "gemini-3.5-flash-lite" : "gemini-3.1-flash-lite";
    return model;
  }
  private async available(grant: AuthGrant, signal: AbortSignal): Promise<Json> {
    const tiers = [
      ...new Set(
        [text(grant.paidTier), text(grant.tier)].filter(
          (t) => t && t !== "free-tier" && t !== "legacy-tier",
        ),
      ),
      "",
    ];
    for (const tier of tiers) {
      try {
        return await this.call(
          grant,
          "fetchAvailableModels",
          { project: grant.projectId, ...(tier ? { entitlement: { userTier: tier } } : {}) },
          signal,
        );
      } catch (error) {
        signal.throwIfAborted();
        if (!tier) throw error;
      }
    }
    throw new Error("Antigravity model directory unavailable");
  }
  async models(grant: AuthGrant, signal: AbortSignal): Promise<readonly AuthModel[]> {
    const { data: metadata } = await this.metadata.read(signal);
    if (this.channel === "gemini") {
      const raw = await this.call(grant, "retrieveUserQuota", { project: grant.projectId }, signal),
        f = await this.flags(grant, signal);
      const preview = list(raw.buckets).some((b) => text(record(b).modelId).includes("-preview"));
      const skip: Record<string, boolean> = {
        "gemini-3.1-pro-preview": !f.get(45760185) || !preview || !!f.get(45768879),
        "gemini-3-pro-preview": !!f.get(45760185) || !preview || !!f.get(45768879),
        "gemini-3-flash-preview": !preview,
        "gemini-3.8-flash": !f.get(45842815),
        "gemini-3.5-flash": !!f.get(45842815),
        "gemini-3.5-flash-lite": !f.get(45827489),
        "gemini-3.1-flash-lite": !!f.get(45827489),
        "gemini-2.5-pro": !!f.get(45768879),
        "gemini-2.5-flash": !!f.get(45842815),
      };
      return definitions
        .filter(([id]) => !skip[id])
        .map(([id, name]) => ({
          id,
          name,
          protocol: "anthropic-messages",
          baseURL: this.baseURL,
          ...googleMetadata(id, this.channel, metadata),
          images: true,
        }));
    }
    const raw = await this.available(grant, signal);
    const order = list(raw.agentModelSorts)
      .flatMap((sort) => list(record(sort).groups).flatMap((group) => list(record(group).modelIds)))
      .map(text);
    const entries = Object.entries(record(raw.models)).filter(
      ([id]) =>
        !id.startsWith("chat_") &&
        !id.startsWith("tab_") &&
        !["gemini-2.5-pro", "gemini-2.5-flash-thinking"].includes(id),
    );
    entries.sort(
      ([a], [b]) =>
        (order.includes(a) ? order.indexOf(a) : Infinity) -
        (order.includes(b) ? order.indexOf(b) : Infinity),
    );
    if (!entries.length) {
      this.loaded = true;
      this.fellBack = true;
      return agFallback.map(([id, name]) => ({
        id,
        name,
        protocol: "anthropic-messages",
        baseURL: this.baseURL,
        ...googleMetadata(id, this.channel, metadata),
        images: !id.startsWith("gpt-oss"),
      }));
    }
    const models: AuthModel[] = entries.map(([id, value]) => {
      const m = record(value);
      return {
        id,
        name: text(m.displayName) || agFallback.find(([known]) => known === id)?.[1] || id,
        protocol: "anthropic-messages",
        baseURL: this.baseURL,
        ...googleMetadata(id, this.channel, metadata),
        contextWindow: (number(m.maxTokens) ?? 0) > 0 ? number(m.maxTokens) : undefined,
        maxOutputTokens:
          (number(m.maxOutputTokens) ?? 0) > 0 ? number(m.maxOutputTokens) : undefined,
        images:
          typeof m.supportsImages === "boolean" ? m.supportsImages : !id.startsWith("gpt-oss"),
      };
    });
    const collapsed = collapseGoogleModels(models);
    this.variants = collapsed.wire;
    this.loaded = true;
    this.fellBack = false;
    return collapsed.models;
  }
  async quota(grant: AuthGrant, signal: AbortSignal): Promise<Json> {
    const plan = text(grant.plan);
    if (this.channel === "gemini") {
      const raw = await this.call(grant, "retrieveUserQuota", { project: grant.projectId }, signal),
        flags = await this.flags(grant, signal);
      return {
        ...raw,
        buckets: list(raw.buckets).map((value) => {
          const bucket = record(value);
          return { ...bucket, modelId: this.shown(text(bucket.modelId), flags) };
        }),
        ...(plan ? { plan } : {}),
      };
    }
    const [models, summary] = await Promise.allSettled([
      this.available(grant, signal),
      this.call(grant, "retrieveUserQuotaSummary", { project: grant.projectId }, signal),
    ]);
    signal.throwIfAborted();
    if (models.status === "rejected" && summary.status === "rejected")
      throw new Error("Google quota requests failed");
    return {
      ...(models.status === "fulfilled" ? { models: models.value.models } : {}),
      ...(summary.status === "fulfilled" ? { groups: summary.value.groups } : {}),
      ...(plan ? { plan } : {}),
      ...(models.status === "rejected" || summary.status === "rejected" ? { partial: true } : {}),
    };
  }
}
