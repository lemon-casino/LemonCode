import { z } from "zod";
import type { AuthDriver, AuthDriverFactory } from "@lcode/provider-node";
import {
  providerAccountModelSchema,
  type ProviderAccountChannel,
  type ProviderAccount,
} from "@lcode/shared";

export async function loadProviderAuthChannels(
  channels: readonly { id: string; name: string }[],
  factory: AuthDriverFactory,
): Promise<readonly ProviderAccountChannel[]> {
  return Promise.all(
    channels.map(async (channel) => {
      let driver: AuthDriver | undefined;
      try {
        driver = await factory(channel.id);
        return { ...channel, methods: await driver.methods() };
      } catch {
        return { ...channel, methods: [], error: "Authorization driver unavailable" };
      } finally {
        await driver?.dispose?.();
      }
    }),
  );
}
export const PROVIDER_AUTH_CHANNELS = [
  ["bigmodel", "BigModel Coding Plan"],
  ["zai", "Z.AI Coding Plan"],
  ["codex", "OpenAI Codex"],
  ["chatgpt-api", "ChatGPT API"],
  ["copilot", "GitHub Copilot"],
  ["gemini", "Google Gemini CLI"],
  ["antigravity", "Google Antigravity"],
  ["claude", "Claude Code"],
  ["cline", "Cline"],
  ["commandcode-plan", "Command Code"],
  ["cursor", "Cursor"],
  ["devin", "Devin"],
  ["factory", "Factory"],
  ["grok", "Grok"],
  ["kiro", "Kiro"],
  ["minimax-code", "MiniMax Coding Plan"],
  ["minimax-code-global", "MiniMax Global"],
  ["mimo-app", "MiMo"],
  ["qoder", "Qoder"],
  ["qoder-cn", "Qoder CN"],
  ["trae-cn", "Trae CN"],
  ["trae-global", "Trae Global"],
  ["workbuddy", "WorkBuddy"],
  ["workbuddy-ai", "WorkBuddy AI"],
  ["zed", "Zed"],
].map(([id, name]) => ({ id: id!, name: name! }));
export const grantSchema = z.object({ type: z.enum(["oauth", "api"]) }).passthrough();
export const modelSchema = providerAccountModelSchema
  .extend({ baseURL: z.string().url() })
  .strict();
export const accountSchema = z
  .object({
    connectionId: z.string().uuid(),
    channelId: z.string(),
    displayName: z.string(),
    enabled: z.boolean(),
    generation: z.number().int(),
    grant: grantSchema,
    models: z.array(modelSchema),
    error: z.string().optional(),
    authorizationStatus: z.enum(["expired", "kept", "renewed"]).optional(),
  })
  .strict();
export const storeSchema = z
  .object({ version: z.literal(1), accounts: z.array(accountSchema) })
  .strict();
export type StoredAccount = z.infer<typeof accountSchema>;
export function projectProviderAccount(account: StoredAccount): ProviderAccount {
  return {
    connectionId: account.connectionId,
    channelId: account.channelId,
    displayName: account.displayName,
    enabled: account.enabled,
    status: account.error ? "error" : "ready",
    models: account.models.map(({ baseURL: _url, ...model }) => model),
    ...(account.error ? { error: account.error } : {}),
    ...(account.authorizationStatus ? { authorizationStatus: account.authorizationStatus } : {}),
  };
}
