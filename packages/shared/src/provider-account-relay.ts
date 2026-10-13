import { z } from "zod";

/** 仅受信 Desktop Host ↔ Server stdio 使用，不注册到 Renderer/HTTP 服务集合。 */
export const PROVIDER_ACCOUNT_RELAY_CHANNEL = "host-provider-account-relay";
export const PROVIDER_ACCOUNT_RELAY_ENV = "LCODE_REMOTE_PROVIDER_ACCOUNT_RELAY";
export const PROVIDER_ACCOUNT_RELAY_MAX_BODY_BYTES = 32 * 1024 * 1024;
export const PROVIDER_ACCOUNT_RELAY_CHUNK_BYTES = 64 * 1024;

const protocol = z.enum(["anthropic-messages", "openai-chat-completions", "openai-responses"]);
export const providerAccountRelayRequestIdSchema = z.string().uuid();
export const providerAccountRelayOpenSchema = z
  .object({
    requestId: providerAccountRelayRequestIdSchema,
    channelId: z.string().min(1).max(256),
    modelId: z.string().min(1).max(512),
    protocol,
    sessionId: z.string().max(4096).optional(),
    body: z
      .string()
      .max(Math.ceil(PROVIDER_ACCOUNT_RELAY_MAX_BODY_BYTES / 3) * 4)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/u)
      .refine((value) => value.length % 4 === 0),
    headers: z
      .object({
        "anthropic-version": z.string().max(1024).optional(),
        "anthropic-beta": z.string().max(4096).optional(),
        accept: z.string().max(1024).optional(),
      })
      .strict(),
  })
  .strict();
export type ProviderAccountRelayOpen = z.infer<typeof providerAccountRelayOpenSchema>;

export const providerAccountRelayHeadSchema = z
  .object({
    status: z.number().int().min(200).max(599),
    headers: z
      .object({
        "content-type": z.string().optional(),
        "retry-after": z.string().optional(),
        "x-zcode-connection-id": z.string().optional(),
      })
      .strict(),
  })
  .strict();
export type ProviderAccountRelayHead = z.infer<typeof providerAccountRelayHeadSchema>;

export const providerAccountRelayChunkSchema = z.discriminatedUnion("done", [
  z.object({ done: z.literal(true) }).strict(),
  z
    .object({
      done: z.literal(false),
      data: z
        .string()
        .max(Math.ceil(PROVIDER_ACCOUNT_RELAY_CHUNK_BYTES / 3) * 4)
        .regex(/^[A-Za-z0-9+/]*={0,2}$/u)
        .refine((value) => value.length % 4 === 0),
    })
    .strict(),
]);
export type ProviderAccountRelayChunk = z.infer<typeof providerAccountRelayChunkSchema>;
