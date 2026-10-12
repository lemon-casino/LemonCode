/** Host-only provider authentication contract. No private grant is sent to Renderer. */
export type AuthWireProtocol =
  | "anthropic-messages"
  | "openai-chat-completions"
  | "openai-responses";
export interface AuthGrant {
  type: "oauth" | "api";
  access?: string;
  refresh?: string;
  expires?: number;
  key?: string;
  accountId?: string;
  [key: string]: unknown;
}
export interface AuthInputField {
  key: string;
  label: string;
  type: "text" | "password" | "select";
  options?: readonly { label: string; value: string; hint?: string }[];
  optional?: boolean;
  placeholder?: string;
  condition?: { key: string; value: string };
  defaultValue?: string;
}
export interface AuthMethod {
  id: string;
  label: string;
  type: "oauth" | "api";
  fields?: readonly AuthInputField[];
  kind?: "browser" | "local" | "import" | "credentials";
  description?: string;
}
export interface AuthModel {
  id: string;
  name: string;
  protocol: AuthWireProtocol;
  baseURL: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  images?: boolean;
  reasoning?: boolean;
  reasoningEfforts?: readonly string[];
  serviceTiers?: readonly string[];
  maxContextWindow?: number;
  reasoningVariants?: readonly { id: string; options: Record<string, unknown> }[];
  toolCall?: boolean;
  inputModalities?: readonly ("text" | "image" | "video" | "audio" | "pdf")[];
}
export interface AuthDriverContext {
  readonly connectionId?: string;
  read(): Promise<AuthGrant | null>;
  /** Replaces the current grant; Host rejects writes after the account/attempt generation changes. */
  write(grant: AuthGrant): Promise<void>;
  signal?: AbortSignal;
  reportSignIn?(status: "expired" | "kept" | "renewed"): Promise<void>;
}
export interface AuthChallenge {
  url?: string;
  instructions?: string;
  method: "auto" | "code";
  complete(code?: string): Promise<AuthGrant>;
  /** Batch imports use the same attempt/cancellation boundary; private grants stay in Host. */
  completeMany?(): Promise<readonly AuthImportEntry[]>;
  cancel?(): void;
}
export type AuthImportEntry =
  | { status: "ready"; grant: AuthGrant; label?: string }
  | { status: "failed" | "exists"; label?: string; error?: string };
export interface AuthDriver {
  methods(): Promise<readonly AuthMethod[]>;
  authorize(
    methodId: string,
    inputs: Record<string, string>,
    signal: AbortSignal,
  ): Promise<AuthChallenge>;
  models(context: AuthDriverContext): Promise<readonly AuthModel[]>;
  modelCatalog?(context: AuthDriverContext): Promise<{
    models: readonly AuthModel[];
    fallback?: boolean;
  }>;
  fetch(request: Request, context: AuthDriverContext): Promise<Response>;
  quota?(context: AuthDriverContext): Promise<unknown>;
  dispose?(): void | Promise<void>;
}
export type AuthDriverFactory = (channelId: string) => Promise<AuthDriver>;
export interface AuthDriverNetworkOptions {
  resolveNetwork(): Promise<import("../provider-network.js").HostApiNetworkOptions>;
}
