/* eslint-disable max-lines -- AI SDK 模型执行装配集中维护 provider factory、鉴权和网络错误适配，拆分会让状态同步更脆弱。 */
// ============================================================
// Vercel AI SDK model execution
// ============================================================

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import {
  compileModelOptionMaps,
  type CompiledModelOptionMaps,
  type ModelOptionValues,
} from "@lcode/model-option-map";
import {
  ModelErrorCode,
  ModelFailureReason,
  ModelProtocolError,
  type Logger,
  type ModelUsage,
  type ModelId,
  type ModelProviderId,
  type ModelRequestAuth,
} from "@lcode/contracts";
import {
  resolveProviderNetworkConfig,
  type ProviderApiKey,
  type RegistryProviderConfig,
  type RoutingRequest,
} from "@lcode/provider";
import { withOpenRouterAttributionHeaders } from "@lcode/shared";
import { createAnthropicCompatFetch } from "./anthropic-stream-compat.js";
import { createOpenAIResponsesJsonCompatFetch } from "./openai-responses-json-compat.js";
import { createModelOptionMapFetch, type RawRequestBodyCapture } from "./model-option-map-fetch.js";
import { createNetworkProxyFetch } from "../network/proxy-fetch.js";
import { NetworkFetchCache } from "../network/network-fetch-cache.js";
import { createOfficialCodingPlanGatewayFetch } from "./official-coding-plan-gateway.js";
import { normalizeModelTlsFailure } from "./failure-tls.js";
import { mergeModelRequestHeaders } from "./model-request-headers.js";
import { observeModelSpeed, type ModelSpeedObservation } from "./model-speed-observation.js";
import { FileSharedQuotaCoordinator } from "./api-key-shared-quota.js";
import { ApiKeyPoolRegistry, type ApiKeyPool } from "./api-key-pool.js";
import { routingUsage } from "./routing-usage.js";
import { createRoutingFeedback, routingFailure } from "./routing-feedback.js";
import { sniffModelSseResponse } from "./model-sse-sniff.js";
import { createApiKeyFailoverFetch, withApiKeyLease } from "./api-key-fetch.js";
export { createApiKeyFailoverFetch } from "./api-key-fetch.js";
export type { ApiKeyFailoverState } from "./api-key-fetch.js";

export type AiSdkProviderKind = "openai" | "anthropic" | "openai-compatible";

export type EnvRecord = Record<string, string | undefined>;

interface AiSdkProviderConfig {
  network?: RegistryProviderConfig["network"];
  access: RegistryProviderConfig["access"];
  kind: AiSdkProviderKind;
  apiKey?: string;
  apiKeys?: readonly ProviderApiKey[];
  baseURL: string;
  headers?: Record<string, string>;
  providerOptions?: Record<string, unknown>;
  name?: string;
}

export interface AiSdkModelExecutionConfig {
  /** 同一数据目录内的跨进程共享池 owner；未注入 SDK 保留进程内行为。 */
  routingQuotaDirectory?: string;
  /** 执行环境提供的默认来源信息，不属于 Provider 持久化配置。 */
  defaultHeaders?: Readonly<Record<string, string>>;
  env?: EnvRecord;
  network?: AiSdkNetworkConfig;
}

export interface AiSdkModelExecutionOptions {
  logger?: Logger;
  transport?: ProviderFetch;
}

export interface AiSdkNetworkConfig {
  http2?: "disabled" | "negotiate";
  caCertFile?: string;
  httpProxy?: string;
  noProxy?: string;
}

export interface AiSdkResolvedModel {
  acquireApiKeyAttempt?: (
    signal?: AbortSignal,
    outsideTicket?: (wait: () => Promise<void>, signal?: AbortSignal) => Promise<void>,
    context?: RoutingRequest,
  ) => Promise<ApiKeyBoundAttempt>;
  apiKeyAttempt?: ApiKeyBoundAttempt;
  baseURL?: string;
  headers?: Record<string, string>;
  providerId: ModelProviderId;
  modelId: ModelId;
  model: LanguageModel;
  providerKind: AiSdkProviderKind;
  providerOptions?: Record<string, unknown>;
  rawRequestBodyCapture?: RawRequestBodyCapture;
  speedObservation?: ModelSpeedObservation;
  observeRoutingUsage?: (usage: ModelUsage) => Promise<void> | void;
  observeRoutingFailure?: (
    status: number | undefined,
    headers: Record<string, string> | undefined,
    outputCommitted?: boolean,
    cancelled?: boolean,
  ) => Promise<void>;
}

export interface ApiKeyBoundAttempt {
  observeUsage?(usage: ModelUsage): void;
  readonly keyId: string;
  readonly model: LanguageModel;
  readonly canRotate: boolean;
  release(): Promise<void> | void;
  flushRouting?(): Promise<void>;
  observeFailure(
    status: number | undefined,
    headers: Record<string, string> | undefined,
    outputCommitted?: boolean,
    cancelled?: boolean,
  ): void;
}

export interface AiSdkBoundModelResolution {
  readonly resolved: AiSdkResolvedModel;
  resolveRequest(input: {
    readonly options: ModelOptionValues;
    readonly requestAuth?: ModelRequestAuth;
  }): AiSdkResolvedModel;
}

type LanguageModelFactory = (modelId: string) => Parameters<typeof observeModelSpeed>[0];
type ProviderFetch = typeof globalThis.fetch;
type ProviderCode = string | number;

export interface ProviderBusinessErrorFetchOptions {
  streamRequested?: () => boolean;
  caCertFile?: string;
  env?: EnvRecord;
  providerId: string;
  providerKind: AiSdkProviderKind;
  fetch?: ProviderFetch;
  httpProxy?: string;
  noProxy?: string;
}

export interface ProviderBusinessErrorOptions {
  providerCode?: ProviderCode;
  providerId: string;
  providerKind: AiSdkProviderKind;
  providerMessage?: string;
  providerRequestId?: string;
  responseBodySummary?: Record<string, unknown>;
  responseHeaders?: Record<string, string>;
  responseStatus?: number;
  statusCode?: number;
}

export class ProviderBusinessError extends Error {
  readonly code = "PROVIDER_BUSINESS_ERROR";
  readonly isProviderBusinessError = true;
  readonly providerCode?: ProviderCode;
  readonly providerId: string;
  readonly providerKind: AiSdkProviderKind;
  readonly providerMessage?: string;
  readonly providerRequestId?: string;
  readonly responseBodySummary?: Record<string, unknown>;
  readonly responseHeaders?: Record<string, string>;
  readonly responseStatus?: number;
  readonly statusCode?: number;

  constructor(options: ProviderBusinessErrorOptions) {
    const providerMessage =
      normalizeProviderMessage(options.providerMessage) ?? "Provider returned a business error.";
    super(providerMessage);
    this.name = "ProviderBusinessError";
    this.providerCode = options.providerCode;
    this.providerId = options.providerId;
    this.providerKind = options.providerKind;
    this.providerMessage = providerMessage;
    this.providerRequestId = options.providerRequestId;
    this.responseBodySummary = options.responseBodySummary;
    this.responseHeaders = options.responseHeaders;
    this.responseStatus = options.responseStatus;
    this.statusCode = options.statusCode;
  }
}

export function isProviderBusinessError(error: unknown): error is ProviderBusinessError {
  if (error instanceof ProviderBusinessError) {
    return true;
  }

  const record = asRecord(error);
  return record?.isProviderBusinessError === true && record.name === "ProviderBusinessError";
}

const MAX_BUSINESS_ERROR_BODY_CHARS = 64_000;
const MAX_PROVIDER_MESSAGE_CHARS = 1_000;
const PROVIDER_BUSINESS_ERROR_BODY_CLEANUP_TIMEOUT_MS = 1_000;
const PROVIDER_BUSINESS_ERROR_WRAPPER_CODE = "PROVIDER_BUSINESS_ERROR";
const SSE_FRAME_SEPARATOR_PATTERN = /\r\n\r\n|\n\n|\r\r/;
const AUTHORIZATION_HEADER_NAME = "Authorization";

export class AiSdkModelExecution {
  private readonly env: EnvRecord;
  private readonly defaultHeaders: Record<string, string>;
  private readonly network: AiSdkNetworkConfig;
  private readonly logger?: Logger;
  private readonly baseTransport?: ProviderFetch;
  private readonly networkResources = new NetworkFetchCache();
  private disposed = false;
  private closing?: Promise<void>;
  private readonly apiKeyPools: ApiKeyPoolRegistry;
  /** 私有 adapter 观测端口；不经 Renderer 注册，不允许指定凭据或上游 URL。 */
  observeApiKeyRoutingQuota(
    providerId: string,
    snapshot: import("@lcode/shared").ApiKeyQuotaSnapshot,
  ): void {
    this.apiKeyPools.observeQuota(providerId, snapshot);
  }
  /** 仅受信 adapter 能提交共享 owner 的全局覆盖证明；不注册 Renderer 写入口。 */
  observeSharedApiKeyQuota(
    providerId: string,
    snapshot: import("@lcode/shared").ApiKeyQuotaSnapshot,
    coversThroughSeq?: number,
  ) {
    return this.apiKeyPools.observeSharedQuota(providerId, snapshot, coversThroughSeq);
  }
  readSharedApiKeyQuota(providerId: string, poolId: string) {
    return this.apiKeyPools.readSharedQuota(providerId, poolId);
  }
  readApiKeyRoutingDiagnostics(
    providerId: string,
    input?: Parameters<ApiKeyPoolRegistry["readDiagnostics"]>[1],
  ) {
    return this.apiKeyPools.readDiagnostics(providerId, input);
  }

  constructor(config: AiSdkModelExecutionConfig = {}, options: AiSdkModelExecutionOptions = {}) {
    this.env = config.env ?? process.env;
    this.apiKeyPools = new ApiKeyPoolRegistry(
      config.routingQuotaDirectory
        ? new FileSharedQuotaCoordinator(config.routingQuotaDirectory)
        : undefined,
    );
    this.defaultHeaders = { ...config.defaultHeaders };
    this.network = { ...config.network };
    this.logger = options.logger;
    this.baseTransport = options.transport;
  }

  /**
   * 固定一个 Model 创建时使用的 Provider 静态事实。
   *
   * 请求期鉴权只覆盖 API Key 与 Header；Registry 后续热更新不会让已经创建的
   * Model 静默切换 Endpoint、协议、Provider Options 或 SDK Factory。
   */
  bindModel(input: {
    readonly providerId: string;
    readonly modelId: string;
    readonly providerConfig: RegistryProviderConfig;
    /** 创建时冻结。后续 resolveRequest 不得再读保存代次。 */
    readonly providerSaveGeneration?: string;
    readonly supportsJsonSchemaOutput: boolean;
    readonly optionSpecs: {
      readonly reasoningLevel: { readonly map: string };
      readonly maxOutputTokens: { readonly map: string };
      readonly speed?: { readonly map: string };
    };
  }): AiSdkBoundModelResolution {
    this.assertActive(input.providerId, input.modelId);
    const snapshot = this.captureModelSnapshot(input);
    const optionMaps = compileModelOptionMaps(input.optionSpecs);
    return {
      // 这里只构造不执行请求的基础 Model；真正请求必须通过 resolveRequest 绑定完整 options。
      resolved: this.resolveSnapshot(snapshot, undefined, undefined, undefined),
      resolveRequest: ({ options, requestAuth }) =>
        this.resolveSnapshot(snapshot, requestAuth, optionMaps, options),
    };
  }

  private captureModelSnapshot(input: {
    readonly providerId: string;
    readonly modelId: string;
    readonly providerConfig: RegistryProviderConfig;
    readonly providerSaveGeneration?: string;
    readonly supportsJsonSchemaOutput: boolean;
  }): AiSdkModelSnapshot {
    const configuredProvider = toAiSdkProviderConfig(
      input.providerId,
      input.providerConfig,
      this.apiKeyPools,
    );
    let apiKeyPool: ApiKeyPool | undefined;
    try {
      if (configuredProvider.apiKeys?.length)
        apiKeyPool = this.apiKeyPools.get(
          input.providerId,
          input.providerSaveGeneration,
          configuredProvider.apiKeys,
          input.providerConfig.routing,
        );
    } catch (error) {
      throw new ModelProtocolError(
        ModelErrorCode.InvalidModelRequest,
        error instanceof Error ? error.message : "Invalid API key catalog",
        {
          providerId: input.providerId,
          modelId: input.modelId,
          reason: ModelFailureReason.InvalidRequest,
          retryable: false,
        },
      );
    }
    const providerSaveGeneration = input.providerSaveGeneration;
    // 重构后模型 SDK 曾只接到用户 Header，漏掉版本和站点归因；在公共绑定边界恢复，
    // 不依赖签名成功，不给各业务重复补头，也不修改 Provider 或已绑定 Model 的配置。
    configuredProvider.headers = mergeModelRequestHeaders(
      withOpenRouterAttributionHeaders(this.defaultHeaders, configuredProvider.baseURL),
      configuredProvider.headers,
    );
    const apiKey = this.resolveApiKey(configuredProvider);
    return {
      providerConfig: {
        ...configuredProvider,
        ...(apiKey ? { apiKey } : {}),
        ...(configuredProvider.headers ? { headers: { ...configuredProvider.headers } } : {}),
        ...(configuredProvider.providerOptions
          ? { providerOptions: { ...configuredProvider.providerOptions } }
          : {}),
      },
      providerId: input.providerId as ModelProviderId,
      apiKeyPool,
      modelId: input.modelId as ModelId,
      supportsJsonSchemaOutput: input.supportsJsonSchemaOutput,
      ...(providerSaveGeneration === undefined ? {} : { providerSaveGeneration }),
    };
  }

  private resolveSnapshot(
    snapshot: AiSdkModelSnapshot,
    requestAuth: ModelRequestAuth | undefined,
    optionMaps: CompiledModelOptionMaps | undefined,
    optionValues: ModelOptionValues | undefined,
  ): AiSdkResolvedModel {
    this.assertActive(String(snapshot.providerId), String(snapshot.modelId));
    const providerConfig = applyModelRequestAuth(snapshot.providerConfig, requestAuth);
    const feedback =
      requestAuth?.routingFeedback && providerConfig.access.type === "oauth-account"
        ? createRoutingFeedback(
            this.resolveOAuthLoopbackTransport(),
            providerConfig.baseURL,
            providerConfig.apiKey,
            this.logger,
          )
        : undefined;
    // Model 创建时的 Provider 事实必须被冻结在当前 binding 中。若按 providerId 缓存
    // factory，配置更新后创建的新 Model 会错误复用旧 Endpoint / Header / API Key。
    const rawRequestBodyCapture: RawRequestBodyCapture = {};
    const factory = this.createFactory(
      snapshot.providerId,
      providerConfig,
      optionMaps,
      optionValues,
      rawRequestBodyCapture,
      snapshot.supportsJsonSchemaOutput,
      snapshot.apiKeyPool,
    );
    const model = factory(snapshot.modelId.toString());
    const speedObservation = optionValues?.speed ? { requested: optionValues.speed } : undefined;
    return {
      ...(snapshot.apiKeyPool && providerConfig.apiKeys?.length
        ? {
            acquireApiKeyAttempt: async (signal, outsideTicket, context) => {
              this.assertActive(String(snapshot.providerId), String(snapshot.modelId));
              const lease = await snapshot.apiKeyPool!.acquire(signal, outsideTicket, context);
              try {
                const factory = this.createFactory(
                  snapshot.providerId,
                  providerConfig,
                  optionMaps,
                  optionValues,
                  rawRequestBodyCapture,
                  snapshot.supportsJsonSchemaOutput,
                  snapshot.apiKeyPool,
                  lease,
                );
                const model = factory(snapshot.modelId.toString());
                return {
                  keyId: lease.key.id,
                  observeUsage: (usage: ModelUsage) =>
                    lease.observeUsage?.({
                      outcome: "success",
                      workUnits: routingUsage(usage).workUnits,
                      tokens: {
                        input: routingUsage(usage).inputTokens,
                        output: routingUsage(usage).outputTokens,
                        total: routingUsage(usage).workUnits,
                      },
                    }),
                  model: speedObservation ? observeModelSpeed(model, speedObservation) : model,
                  get canRotate() {
                    return lease.canRotate;
                  },
                  flushRouting: () => lease.flushRouting?.() ?? Promise.resolve(),
                  release: () => {
                    lease.release();
                    return lease.flushRouting?.();
                  },
                  observeFailure: (status, headers, outputCommitted, cancelled) => {
                    lease.observeUsage?.(
                      routingFailure(status, headers, outputCommitted, cancelled),
                    );
                    if (status === 429) lease.observe(429, new Headers(headers));
                  },
                };
              } catch (error) {
                lease.release();
                throw error;
              }
            },
          }
        : {}),
      baseURL: providerConfig.baseURL,
      ...(feedback
        ? {
            observeRoutingUsage: (usage: ModelUsage) =>
              this.disposed
                ? Promise.resolve()
                : feedback({ ...routingUsage(usage), outcome: "success" }),
            observeRoutingFailure: (
              status: number | undefined,
              headers: Record<string, string> | undefined,
              committed?: boolean,
              cancelled?: boolean,
            ) =>
              this.disposed
                ? Promise.resolve()
                : feedback(routingFailure(status, headers, committed, cancelled)),
          }
        : {}),
      headers: providerConfig.headers,
      providerId: snapshot.providerId,
      modelId: snapshot.modelId,
      model: speedObservation ? observeModelSpeed(model, speedObservation) : model,
      providerKind: providerConfig.kind,
      providerOptions: providerConfig.providerOptions,
      rawRequestBodyCapture,
      speedObservation,
    };
  }

  private createFactory(
    providerId: string,
    providerConfig: AiSdkProviderConfig,
    optionMaps: CompiledModelOptionMaps | undefined,
    optionValues: ModelOptionValues | undefined,
    rawRequestBodyCapture: RawRequestBodyCapture,
    supportsJsonSchemaOutput: boolean,
    apiKeyPool?: ApiKeyPool,
    lease?: import("./api-key-pool.js").ApiKeyLease,
  ): LanguageModelFactory {
    const apiKey = this.resolveApiKey(providerConfig);
    const headers = providerConfig.headers;
    // OAuth Host票据仅用于同一执行环境回环端口，不能被用户配置的外部HTTP代理转发。
    const providerTransport =
      providerConfig.access.type === "oauth-account"
        ? this.resolveOAuthLoopbackTransport()
        : this.resolveProviderTransport(providerId, providerConfig.network);
    const apiKeyTransport = lease
      ? withApiKeyLease(providerTransport, lease, providerConfig.kind)
      : providerConfig.apiKeys?.length
        ? createApiKeyFailoverFetch({
            fetch: providerTransport,
            keys: providerConfig.apiKeys,
            providerKind: providerConfig.kind,
            pool: apiKeyPool,
          })
        : providerTransport;
    const fetch = createProviderBusinessErrorFetch({
      streamRequested: () => rawRequestBodyCapture.body?.stream === true,
      fetch: apiKeyTransport,
      providerId,
      providerKind: providerConfig.kind,
    });
    const optionFetch =
      optionMaps && optionValues
        ? createModelOptionMapFetch({
            capture: rawRequestBodyCapture,
            fetch,
            maps: optionMaps,
            values: optionValues,
          })
        : fetch;

    switch (providerConfig.kind) {
      case "openai": {
        const provider = createOpenAI({
          apiKey,
          baseURL: providerConfig.baseURL,
          fetch: createOpenAIResponsesJsonCompatFetch(optionFetch),
          headers,
        });
        return provider.responses as LanguageModelFactory;
      }

      case "anthropic": {
        const provider = createAnthropic({
          apiKey,
          baseURL: normalizeAnthropicBaseURL(providerConfig.baseURL),
          fetch: createAnthropicCompatFetch(optionFetch, { speed: optionValues?.speed }),
          headers: withAnthropicAuthorizationHeader(apiKey, headers),
        });
        return provider as LanguageModelFactory;
      }

      case "openai-compatible": {
        const provider = createOpenAICompatible<string, string, string, string>({
          name: providerConfig.name ?? providerId,
          baseURL: providerConfig.baseURL,
          apiKey,
          fetch: optionFetch,
          headers,
          // OpenAI Compatible 流式 usage 需要显式请求，Usage 是执行结果的一部分。
          includeUsage: true,
          // 缺少这一装配时 SDK 默认 false，会把已声明支持的 Schema 静默降为 JSON object。
          // 使用 binding 冻结的模型事实，不按供应商或实时 Registry 另查一套能力。
          supportsStructuredOutputs: supportsJsonSchemaOutput,
        });
        return provider as LanguageModelFactory;
      }
    }
  }

  private resolveApiKey(providerConfig: AiSdkProviderConfig): string | undefined {
    return providerConfig.apiKey;
  }

  private resolveProviderTransport(
    providerId: string,
    network: RegistryProviderConfig["network"],
  ): ProviderFetch {
    if (network?.mode === "profile")
      throw new Error("Proxy profile must be resolved before model execution");
    // 正式模型绑定同样使用默认直连规则，不能仅修改设置页的选中项。
    network = resolveProviderNetworkConfig(network);
    const key = JSON.stringify([providerId, network ?? null]);
    // 官方 Coding Plan 端点先替换为平台网关端点，再进入用户 HTTP 代理 fetch，
    // httpProxy / noProxy 按实际发送地址判定。
    const frozenNetwork = network;
    const networkFetch = this.networkResources.fetchFor(key, (onIdle) =>
      createNetworkProxyFetch({
        http2: this.network.http2 ?? "negotiate",
        onIdle,
        caCertFile:
          frozenNetwork?.mode === "custom"
            ? frozenNetwork.caCertPath || this.network.caCertFile
            : this.network.caCertFile,
        // 专用/直连不能再回退到进程 HTTP_PROXY；同一供应商更新配置后按新策略创建 transport。
        env:
          network && network.mode !== "default"
            ? Object.fromEntries(
                Object.entries(this.env).filter(
                  ([key]) =>
                    !/^(https?_proxy|all_proxy|no_proxy|LCODE_HTTP_PROXY|LCODE_NO_PROXY|LCODE_TOOL_ENV_PASSTHROUGH_JSON)$/i.test(
                      key,
                    ),
                ),
              )
            : this.env,
        fetch: this.baseTransport,
        httpProxy:
          !network || network.mode === "default"
            ? this.network.httpProxy
            : network.mode === "custom"
              ? network.httpProxy
              : undefined,
        noProxy:
          !network || network.mode === "default"
            ? this.network.noProxy
            : network.mode === "custom"
              ? network.noProxy
              : undefined,
        forceDirect: Boolean(network && network.mode !== "default"),
      }),
    );
    const transport = createOfficialCodingPlanGatewayFetch({ env: this.env, fetch: networkFetch });
    return transport;
  }

  private resolveOAuthLoopbackTransport(): ProviderFetch {
    return this.networkResources.fetchFor("oauth-loopback", (onIdle) =>
      createNetworkProxyFetch({ env: {}, forceDirect: true, fetch: this.baseTransport, onIdle }),
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.networkResources.dispose();
    this.apiKeyPools.dispose();
  }

  private assertActive(providerId: string, modelId: string): void {
    if (!this.disposed) return;
    // 普通错误会落入 workflow 的无上限重试；关闭 owner 必须直接收口为取消。
    throw new ModelProtocolError(
      ModelErrorCode.ModelRequestCancelled,
      "Model execution has been disposed",
      {
        providerId,
        modelId,
        reason: ModelFailureReason.Cancelled,
        retryable: false,
      },
    );
  }

  disposeAndWait(): Promise<void> {
    if (this.closing) return this.closing;
    this.dispose();
    this.closing = this.networkResources.disposeAndWait().then(() => this.apiKeyPools.drain());
    void this.closing.catch(() => {
      this.closing = undefined;
    });
    return this.closing;
  }
}

interface AiSdkModelSnapshot {
  readonly apiKeyPool?: ApiKeyPool;
  readonly supportsJsonSchemaOutput: boolean;
  readonly providerConfig: AiSdkProviderConfig;
  readonly providerId: ModelProviderId;
  readonly modelId: ModelId;
  /** bindModel 时冻结的保存代次。未提供表示没有保存动作，不能当新代次。 */
  readonly providerSaveGeneration?: string;
}

function toAiSdkProviderConfig(
  providerId: string,
  config: RegistryProviderConfig,
  pools: ApiKeyPoolRegistry,
): AiSdkProviderConfig {
  const apiKeys =
    config.access.type === "zhipu-account" || config.access.type === "oauth-account"
      ? []
      : pools.keysFor(config.access);
  const primaryApiKey = pools.primaryKeyFor(apiKeys)?.apiKey;
  const common = {
    network: config.network,
    ...(primaryApiKey ? { apiKey: primaryApiKey } : {}),
    ...(apiKeys.length > 0 ? { apiKeys } : {}),
    baseURL: config.api.baseUrl,
    ...(config.api.headers ? { headers: { ...config.api.headers } } : {}),
    providerOptions: { apiFormat: config.api.type },
    access: config.access,
  };
  switch (config.api.type) {
    case "anthropic-messages":
      return { kind: "anthropic", ...common };
    case "openai-responses":
      return { kind: "openai", ...common };
    case "openai-chat-completions":
      return { kind: "openai-compatible", name: providerId, ...common };
  }
  throw new Error(`Unsupported Provider API type: ${String(config.api.type)}`);
}

function applyModelRequestAuth(
  providerConfig: AiSdkProviderConfig,
  requestAuth: ModelRequestAuth | undefined,
): AiSdkProviderConfig {
  if (!requestAuth) return providerConfig;
  const oauth = providerConfig.access.type === "oauth-account";
  return {
    ...providerConfig,
    ...(oauth && requestAuth.baseURL ? { baseURL: requestAuth.baseURL } : {}),
    ...(oauth && requestAuth.protocol
      ? {
          kind:
            requestAuth.protocol === "anthropic-messages"
              ? "anthropic"
              : requestAuth.protocol === "openai-responses"
                ? "openai"
                : "openai-compatible",
          name: providerConfig.name ?? "oauth",
          providerOptions: { ...providerConfig.providerOptions, apiFormat: requestAuth.protocol },
        }
      : {}),
    ...(requestAuth.apiKey ? { apiKey: requestAuth.apiKey } : {}),
    ...(requestAuth.apiKey ? { apiKeys: [] } : {}),
    ...(requestAuth.headers
      ? { headers: mergeModelRequestHeaders(providerConfig.headers, requestAuth.headers) }
      : {}),
  };
}

function withAnthropicAuthorizationHeader(
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!apiKey || hasHeader(headers, AUTHORIZATION_HEADER_NAME)) {
    return headers;
  }

  // Anthropic 兼容网关会同时读取 x-api-key 和 Bearer Authorization；显式配置的 Authorization 保持优先。
  return {
    [AUTHORIZATION_HEADER_NAME]: `Bearer ${apiKey}`,
    ...headers,
  };
}

function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  if (!headers) {
    return false;
  }
  const normalizedName = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === normalizedName);
}

function normalizeAnthropicBaseURL(baseURL: string | undefined): string | undefined {
  const trimmed = baseURL?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    const pathname = url.pathname.replace(/\/+$/u, "");
    if (pathname.toLowerCase().endsWith("/v1")) {
      url.pathname = pathname;
      return url.href;
    }

    // Anthropic's AI SDK provider appends /messages to baseURL, so explicit
    // gateway roots must include the /v1 API prefix at the adapter boundary.
    url.pathname = `${pathname}/v1`;
    return url.href;
  } catch {
    const withoutTrailingSlash = trimmed.replace(/\/+$/u, "");
    return withoutTrailingSlash.toLowerCase().endsWith("/v1")
      ? withoutTrailingSlash
      : `${withoutTrailingSlash}/v1`;
  }
}

export function createProviderBusinessErrorFetch(
  options: ProviderBusinessErrorFetchOptions,
): ProviderFetch {
  const baseFetch = createProviderProxyFetch(options);

  return async (input, init) => {
    let response: Response;
    try {
      response = await baseFetch(input, init);
      let streamRequested = options.streamRequested?.();
      if (streamRequested === undefined && typeof init?.body === "string") {
        try {
          streamRequested = JSON.parse(init.body)?.stream === true;
        } catch {
          streamRequested = false;
        }
      }
      response = await sniffModelSseResponse(
        response,
        streamRequested === true,
        init?.signal ?? (input instanceof Request ? input.signal : undefined),
      );
    } catch (error) {
      throw normalizeModelTlsFailure(error);
    }

    // zcode-plan 安全校验拒绝（3007）等场景返回 HTTP 403 + JSON，但未必带
    // Content-Type: application/json。若只在启发式命中时才读 body，fetch 会把 403 原样交给
    // AI SDK，流式请求可能以空 completion 结束，core 最终误报 suspicious empty。
    if (!response.ok) {
      const nonOkBusinessError = await detectProviderBusinessError(response, options);
      if (nonOkBusinessError) {
        await consumeBusinessErrorResponseBodyBestEffort(response);
        throw nonOkBusinessError;
      }
    }

    if (responseMayContainSseBusinessError(response)) {
      return createProviderBusinessErrorSseResponse(response, options);
    }

    const businessError = await detectProviderBusinessError(response, options);
    if (businessError) {
      await consumeBusinessErrorResponseBodyBestEffort(response);
      throw businessError;
    }
    return response;
  };
}

async function consumeBusinessErrorResponseBodyBestEffort(response: Response): Promise<void> {
  const body = response.body;
  if (!body) return;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // 业务错误检测消费的是 response.clone()；只 cancel 原始 tee 分支时，
    // Undici 的 cancel Promise 完成也不保证连接已可复用，连续 429 仍会耗尽连接槽。
    // 已识别的业务错误体受 64KB 上限保护，完整消费原始分支后连接才能稳定复用；
    // 异常 stream 永不收敛时则由清理上限兜底，不能阻塞已经解析出的原始错误。
    await Promise.race([
      response.arrayBuffer().then(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, PROVIDER_BUSINESS_ERROR_BODY_CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // 清理失败不能覆盖已经解析出的 provider 原始错误。
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

interface ProviderProxyFetchOptions {
  forceDirect?: boolean;
  caCertFile?: string;
  env?: EnvRecord;
  fetch?: ProviderFetch;
  httpProxy?: string;
  noProxy?: string;
}

function createProviderProxyFetch(options: ProviderProxyFetchOptions): ProviderFetch {
  // Node 的 global fetch 不会自动读取 HTTP_PROXY/http_proxy。
  // 模型 provider 和 MCP HTTP transport 都复用同一层 proxy-aware fetch，避免多套出口规则漂移。
  if (
    !options.env &&
    !options.forceDirect &&
    !options.caCertFile &&
    !options.httpProxy &&
    !options.noProxy
  )
    return options.fetch ?? globalThis.fetch.bind(globalThis);
  return createNetworkProxyFetch(options);
}

async function detectProviderBusinessError(
  response: Response,
  options: ProviderBusinessErrorFetchOptions,
): Promise<ProviderBusinessError | undefined> {
  if (!responseMayContainBusinessJson(response)) {
    return undefined;
  }

  let body: unknown;
  try {
    const text = await readLimitedResponseText(response);
    if (text === undefined || text.trim().length === 0) {
      return undefined;
    }
    body = JSON.parse(text);
  } catch {
    return undefined;
  }

  const failure = readProviderBusinessFailureFromBody(body);
  if (!failure) {
    return undefined;
  }

  return new ProviderBusinessError({
    providerCode: failure.providerCode,
    providerId: options.providerId,
    providerKind: options.providerKind,
    providerMessage: failure.providerMessage,
    providerRequestId: failure.providerRequestId,
    responseBodySummary: failure.responseBodySummary,
    // fetch 层的 ProviderBusinessError 会绕过 APICallError；
    // 不保留响应头会导致 retry-after/retry-after-ms 在重试计算前丢失。
    responseHeaders: responseHeadersToRecord(response.headers),
    responseStatus: response.status,
    statusCode: failure.statusCode,
  });
}

/** 从 HTTP JSON body 解析 zcode-plan 等业务错误（供 failure-classifier 在 APICallError 路径复用）。 */
export function readProviderBusinessFailureFromBody(body: unknown):
  | {
      providerCode?: ProviderCode;
      providerMessage?: string;
      providerRequestId?: string;
      responseBodySummary: Record<string, unknown>;
      statusCode?: number;
    }
  | undefined {
  const record = asRecord(body);
  if (!record) {
    return undefined;
  }

  const errorRecord = asRecord(record.error);
  const providerCode =
    toProviderCode(record.providerCode) ??
    toProviderCode(errorRecord?.providerCode) ??
    toProviderCode(record.error_code) ??
    toProviderCode(errorRecord?.error_code) ??
    // 二次包装后的外层 code 是 LCode 自己的 PROVIDER_BUSINESS_ERROR，
    // 真实上游码在 providerCode；只有没有 providerCode 时才退回读取 code。
    toProviderCode(record.code) ??
    toProviderCode(errorRecord?.code);
  const providerMessage = readProviderMessage(record);
  const failedBySuccess = record.success === false;
  const failedByCode = isNonZeroProviderCode(providerCode);

  if (!failedBySuccess && !failedByCode) {
    return undefined;
  }

  return {
    providerCode,
    providerMessage,
    providerRequestId: readProviderRequestId(record),
    responseBodySummary: summarizeProviderBusinessBody(record),
    statusCode: providerCodeToStatusCode(providerCode),
  };
}

function responseMayContainBusinessJson(response: Response): boolean {
  // 非 2xx 一律尝试读 body 解析业务码（403/3007、429/3002 等），不依赖 Content-Type 猜测。
  if (!response.ok) {
    return true;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("event-stream")) {
    return false;
  }
  if (contentType.includes("json")) {
    return true;
  }

  const contentLength = parseContentLength(response.headers.get("content-length"));
  return contentLength !== undefined && contentLength <= MAX_BUSINESS_ERROR_BODY_CHARS;
}

async function readLimitedResponseText(response: Response): Promise<string | undefined> {
  const contentLength = parseContentLength(response.headers.get("content-length"));
  if (contentLength !== undefined && contentLength > MAX_BUSINESS_ERROR_BODY_CHARS) {
    return undefined;
  }

  const clone = response.clone();
  if (!clone.body) {
    const text = await clone.text();
    return text.length > MAX_BUSINESS_ERROR_BODY_CHARS ? undefined : text;
  }

  const reader = clone.body.getReader();
  const decoder = new TextDecoder();
  let text = "";

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        text += decoder.decode();
        return text.length > MAX_BUSINESS_ERROR_BODY_CHARS ? undefined : text;
      }

      text += decoder.decode(chunk.value, { stream: true });
      if (text.length > MAX_BUSINESS_ERROR_BODY_CHARS) {
        // tee 的另一个分支还要交给 SDK；等待 cancel 会卡住整个模型调用。
        void reader.cancel().catch(() => {});
        return undefined;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function responseMayContainSseBusinessError(response: Response): boolean {
  return (
    response.body !== null &&
    response.headers.get("content-type")?.toLowerCase().includes("event-stream") === true
  );
}

function responseHeadersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function createProviderBusinessErrorSseResponse(
  response: Response,
  options: ProviderBusinessErrorFetchOptions,
): Response {
  const body = response.body;
  if (!body) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  const responseHeaders = responseHeadersToRecord(response.headers);

  return new Response(
    body.pipeThrough(
      createProviderBusinessErrorSseTransform(options, response.status, responseHeaders),
    ),
    {
      headers,
      status: response.status,
      statusText: response.statusText,
    },
  );
}

function createProviderBusinessErrorSseTransform(
  options: ProviderBusinessErrorFetchOptions,
  responseStatus: number,
  responseHeaders: Record<string, string>,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let streamFailed = false;

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (streamFailed) {
        return;
      }

      pending += decoder.decode(chunk, { stream: true });
      pending = emitCompleteProviderBusinessSseFrames(
        pending,
        controller,
        encoder,
        options,
        responseStatus,
        responseHeaders,
        () => {
          streamFailed = true;
        },
      );
    },
    flush(controller) {
      if (streamFailed) {
        return;
      }

      pending += decoder.decode();
      pending = emitCompleteProviderBusinessSseFrames(
        pending,
        controller,
        encoder,
        options,
        responseStatus,
        responseHeaders,
        () => {
          streamFailed = true;
        },
      );
      if (!streamFailed && pending.length > 0) {
        emitProviderBusinessSseFrame(
          pending,
          "",
          controller,
          encoder,
          options,
          responseStatus,
          responseHeaders,
          () => {
            streamFailed = true;
          },
        );
      }
    },
  });
}

function emitCompleteProviderBusinessSseFrames(
  input: string,
  controller: TransformStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  options: ProviderBusinessErrorFetchOptions,
  responseStatus: number,
  responseHeaders: Record<string, string>,
  markFailed: () => void,
): string {
  let pending = input;
  for (;;) {
    const match = SSE_FRAME_SEPARATOR_PATTERN.exec(pending);
    if (!match) {
      return pending;
    }

    const separator = match[0] ?? "";
    const frame = pending.slice(0, match.index);
    pending = pending.slice(match.index + separator.length);
    const emitted = emitProviderBusinessSseFrame(
      frame,
      separator,
      controller,
      encoder,
      options,
      responseStatus,
      responseHeaders,
      markFailed,
    );
    if (!emitted) {
      return "";
    }
  }
}

function emitProviderBusinessSseFrame(
  frame: string,
  separator: string,
  controller: TransformStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  options: ProviderBusinessErrorFetchOptions,
  responseStatus: number,
  responseHeaders: Record<string, string>,
  markFailed: () => void,
): boolean {
  const failure = detectProviderBusinessSseFrameFailure(frame);
  if (failure) {
    // 部分 OpenAI-compatible provider 只在 HTTP 200 SSE error frame 中报告业务错误；
    // 同时保留原始响应头，保证限流场景的 retry-after 能进入后续重试退避。
    controller.error(
      new ProviderBusinessError({
        providerCode: failure.providerCode,
        providerId: options.providerId,
        providerKind: options.providerKind,
        providerMessage: failure.providerMessage,
        providerRequestId: failure.providerRequestId,
        responseBodySummary: failure.responseBodySummary,
        responseHeaders,
        responseStatus,
        statusCode: failure.statusCode,
      }),
    );
    markFailed();
    return false;
  }

  controller.enqueue(encoder.encode(`${frame}${separator}`));
  return true;
}

function detectProviderBusinessSseFrameFailure(frame: string):
  | {
      providerCode?: ProviderCode;
      providerMessage?: string;
      providerRequestId?: string;
      responseBodySummary: Record<string, unknown>;
      statusCode?: number;
    }
  | undefined {
  const sse = readSseFrame(frame);
  const data = sse.data?.trim();
  if (!data || data === "[DONE]") {
    return undefined;
  }

  const body = safeParseRecord(data);
  if (!body) {
    return undefined;
  }

  const businessFailure = readProviderBusinessFailureFromBody(body);
  if (businessFailure) {
    return {
      ...businessFailure,
      providerRequestId: readProviderRequestId(body),
    };
  }

  if (sse.event?.toLowerCase() !== "error") {
    return undefined;
  }

  const errorRecord = asRecord(body.error);
  const providerCode =
    toProviderCode(body.providerCode) ??
    toProviderCode(errorRecord?.providerCode) ??
    toProviderCode(body.error_code) ??
    toProviderCode(errorRecord?.error_code) ??
    // 包装码不能覆盖真实 providerCode。
    toProviderCode(body.code) ??
    toProviderCode(errorRecord?.code);

  return {
    providerCode,
    providerMessage: readProviderMessage(body),
    providerRequestId: readProviderRequestId(body),
    responseBodySummary: summarizeProviderBusinessBody(body),
    statusCode: providerCodeToStatusCode(providerCode),
  };
}

function readSseFrame(frame: string): { data?: string; event?: string } {
  const dataLines: string[] = [];
  let event: string | undefined;
  for (const rawLine of frame.split(/\r\n|\n|\r/)) {
    if (rawLine.startsWith("event:")) {
      event = trimSseFieldValue(rawLine.slice("event:".length));
      continue;
    }
    if (!rawLine.startsWith("data:")) {
      continue;
    }

    dataLines.push(trimSseFieldValue(rawLine.slice("data:".length)));
  }

  return {
    data: dataLines.length === 0 ? undefined : dataLines.join("\n"),
    event,
  };
}

function trimSseFieldValue(value: string): string {
  return value.startsWith(" ") ? value.slice(1) : value;
}

function safeParseRecord(value: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function isNonZeroProviderCode(value: ProviderCode | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && value !== 0;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return false;
  }

  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric !== 0 : true;
}

function providerCodeToStatusCode(value: ProviderCode | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const statusCode = Math.trunc(value);
    return isHttpStatusCode(statusCode) ? statusCode : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    return undefined;
  }

  const statusCode = Number(normalized);
  return isHttpStatusCode(statusCode) ? statusCode : undefined;
}

function isHttpStatusCode(value: number): boolean {
  return Number.isInteger(value) && value >= 100 && value <= 599;
}

function toProviderCode(value: unknown): ProviderCode | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const normalized = value.trim();
    return normalized.toUpperCase() === PROVIDER_BUSINESS_ERROR_WRAPPER_CODE
      ? undefined
      : normalized;
  }
  return undefined;
}

function readProviderMessage(record: Record<string, unknown>): string | undefined {
  const errorRecord = asRecord(record.error);
  return (
    normalizeProviderMessage(record.msg) ??
    normalizeProviderMessage(record.message) ??
    normalizeProviderMessage(errorRecord?.msg) ??
    normalizeProviderMessage(errorRecord?.message) ??
    normalizeProviderMessage(record.error)
  );
}

function readProviderRequestId(record: Record<string, unknown>): string | undefined {
  const errorRecord = asRecord(record.error);
  return (
    normalizeProviderId(record.request_id) ??
    normalizeProviderId(record.requestId) ??
    normalizeProviderId(record.id) ??
    normalizeProviderId(errorRecord?.request_id) ??
    normalizeProviderId(errorRecord?.requestId) ??
    normalizeProviderId(errorRecord?.id)
  );
}

function normalizeProviderMessage(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.length > MAX_PROVIDER_MESSAGE_CHARS
    ? `${normalized.slice(0, MAX_PROVIDER_MESSAGE_CHARS)}...`
    : normalized;
}

function normalizeProviderId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return undefined;
  }
  return normalized.length > MAX_PROVIDER_MESSAGE_CHARS
    ? `${normalized.slice(0, MAX_PROVIDER_MESSAGE_CHARS)}...`
    : normalized;
}

function summarizeProviderBusinessBody(record: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    keys: Object.keys(record).slice(0, 20),
  };

  copyScalar(record, summary, "success");
  copyScalar(record, summary, "code");
  copyScalar(record, summary, "error_code");
  copyScalar(record, summary, "msg");
  copyScalar(record, summary, "message");
  copyScalar(record, summary, "request_id");
  copyScalar(record, summary, "requestId");

  const errorRecord = asRecord(record.error);
  if (errorRecord) {
    const errorSummary: Record<string, unknown> = {
      keys: Object.keys(errorRecord).slice(0, 20),
    };
    copyScalar(errorRecord, errorSummary, "code");
    copyScalar(errorRecord, errorSummary, "error_code");
    copyScalar(errorRecord, errorSummary, "msg");
    copyScalar(errorRecord, errorSummary, "message");
    copyScalar(errorRecord, errorSummary, "request_id");
    copyScalar(errorRecord, errorSummary, "requestId");
    copyScalar(errorRecord, errorSummary, "type");
    summary.error = errorSummary;
  }

  return summary;
}

function copyScalar(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
): void {
  const value = source[key];
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    target[key] = value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
