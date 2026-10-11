import { z } from "zod";

const modelOptionName = z.string().min(1).max(80);
export const providerAccountReasoningOptionsSchema = z.object({
  reasoningEffort: modelOptionName.optional(),
  effort: modelOptionName.optional(),
  thinking: z
    .object({
      type: modelOptionName.optional(),
      budgetTokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
  thinkingConfig: z
    .object({
      includeThoughts: z.boolean().optional(),
      thinkingLevel: modelOptionName.optional(),
      thinkingBudget: z.number().int().min(-1).optional(),
    })
    .optional(),
});

export const providerAccountModelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    protocol: z.enum(["anthropic-messages", "openai-chat-completions", "openai-responses"]),
    contextWindow: z.number().positive().optional(),
    maxOutputTokens: z.number().positive().optional(),
    images: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    reasoningEfforts: z.array(modelOptionName).max(32).optional(),
    serviceTiers: z.array(modelOptionName).max(16).optional(),
    maxContextWindow: z.number().positive().optional(),
    reasoningVariants: z
      .array(
        z.object({ id: modelOptionName, options: providerAccountReasoningOptionsSchema }).strict(),
      )
      .max(32)
      .optional(),
    toolCall: z.boolean().optional(),
    inputModalities: z
      .array(z.enum(["text", "image", "video", "audio", "pdf"]))
      .max(5)
      .optional(),
  })
  .strict();
export interface ProviderAccountField {
  key: string;
  label: string;
  type: "text" | "password" | "select";
  options?: readonly { label: string; value: string; hint?: string }[];
  optional?: boolean;
  placeholder?: string;
  condition?: { key: string; value: string };
  defaultValue?: string;
}
export interface ProviderAccountMethod {
  id: string;
  label: string;
  type: "oauth" | "api";
  fields?: readonly ProviderAccountField[];
  kind?: "browser" | "local" | "import" | "credentials";
  description?: string;
}
export interface ProviderAccountChannel {
  id: string;
  name: string;
  methods: readonly ProviderAccountMethod[];
  error?: string;
}
export type ProviderAccountModel = z.infer<typeof providerAccountModelSchema>;
export interface ProviderAccount {
  connectionId: string;
  channelId: string;
  displayName: string;
  enabled: boolean;
  status: "ready" | "loading" | "error";
  models: readonly ProviderAccountModel[];
  error?: string;
  authorizationStatus?: "expired" | "kept" | "renewed";
}
export interface ProviderAccountView {
  revision: number;
  channels: readonly ProviderAccountChannel[];
  accounts: readonly ProviderAccount[];
}
export interface ProviderAuthorization {
  attemptId: string;
  channelId: string;
  methodId: string;
  status: "pending" | "completed" | "cancelled" | "failed";
  url?: string;
  instructions?: string;
  method: "auto" | "code";
  error?: string;
  connectionId?: string;
  results?: readonly ProviderAccountImportResult[];
}
export interface ProviderAccountImportResult {
  index: number;
  label?: string;
  status: "added" | "updated" | "exists" | "failed";
  connectionId?: string;
  error?: "invalid_credentials" | "authorization_failed";
}
export const startProviderAuthorizationSchema = z
  .object({
    channelId: z.string().min(1),
    methodId: z.string().min(1),
    inputs: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type StartProviderAuthorization = z.infer<typeof startProviderAuthorizationSchema>;
