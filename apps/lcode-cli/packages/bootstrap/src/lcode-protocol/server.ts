import {
  requestClient,
  resolveClientRequest,
  rejectClientRequest,
  cleanupClientRequest,
  type ProtocolClientRequestState,
  type LCodeProtocolOutboundMessage,
} from "./server-client-requests.js";
import { dispatchRequest, type LCodeProtocolPostResponseBatch } from "./server-dispatch.js";

import type { BrowserControlPort } from "@lcode/contracts";
import { InMemoryWorkspaceHookPolicyProvider } from "@lcode/core";
import { parseConversationTopic } from "@lcode/shared/lcode-protocol-v4";
import type {
  LCodeProtocolError,
  LCodeProtocolMessage,
  LCodeProtocolMethod,
  LCodeProtocolRequest,
  LCodeProtocolRequestId,
  LCodeProtocolResponse,
} from "@lcode/shared";

import { ProtocolRuntimeResources } from "./runtime-resources.js";

import {
  V4InteractionRegistry,
  resolveV4InteractionRegistryOptionsFromEnv,
} from "../lcode-protocol-v4/interaction-registry.js";
import { createConversationV4Gateway } from "./v4-bridge.js";
import { createSessionResidentPoolHost } from "./session-residency.js";
import {
  DEFAULT_SESSION_RESIDENT_HIGH_WATER_COUNT,
  SessionResidentPool,
} from "./session-resident-pool.js";
import { createProtocolBrowserControlBroker } from "./browser-control-broker.js";
import {
  createProtocolLogger,
  isErrorResponse,
  isNotification,
  isRequest,
  isResponse,
  ProtocolRequestError,
  type ParamsSchema,
  toProtocolError,
  type LCodeProtocolClientRequestOptions,
  type LCodeProtocolAgentDependencies,
  type LCodeProtocolAgentServerContext,
  type LCodeProtocolSessionRecord,
} from "./server-types.js";
import { createInMemorySessionEventStore } from "@lcode/contracts";

export type { LCodeProtocolAgentDependencies, LCodeProtocolSessionRecord };

function collectResidencySessionIds(params: unknown): string[] {
  if (!params || typeof params !== "object") return [];
  const candidate = params as {
    commands?: unknown;
    sessionId?: unknown;
    topic?: unknown;
  };
  const sessionIds = new Set<string>();
  if (typeof candidate.sessionId === "string" && candidate.sessionId.length > 0) {
    sessionIds.add(candidate.sessionId);
  }
  if (typeof candidate.topic === "string") {
    const topicSessionId = parseConversationTopic(candidate.topic);
    if (topicSessionId) sessionIds.add(topicSessionId);
  }
  if (Array.isArray(candidate.commands)) {
    for (const command of candidate.commands) {
      if (!command || typeof command !== "object") continue;
      const sessionId = (command as { sessionId?: unknown }).sessionId;
      if (typeof sessionId === "string" && sessionId.length > 0) {
        sessionIds.add(sessionId);
      }
    }
  }
  return [...sessionIds];
}

export class LCodeProtocolAgentServer {
  private readonly clientRequests: ProtocolClientRequestState = {
    pendingClientRequests: new Map(),
    nextClientRequestId: 1,
  };
  private readonly runtimeResources: ProtocolRuntimeResources;
  private shutdownPromise?: Promise<void>;
  readonly browserControlPort: BrowserControlPort;
  /**
   * 官方 MCP 身份头端口所需的最小上下文。
   * MCP 连接池的构造早于 server，需要在 server 就绪后回填闭包持有的引用——
   * 与 v4Gateway 同样的构造顺序收口方式。只暴露 requestClient，不外泄整个 context。
   */
  get officialMcpAuthRequestContext(): Pick<LCodeProtocolAgentServerContext, "requestClient"> {
    return this.context;
  }
  private readonly context: LCodeProtocolAgentServerContext;
  private readonly logger;
  private readonly pluginOperationControllers = new Map<string, AbortController>();
  private readonly workspaceGenerateTextControllers = new Map<string, AbortController>();
  /**
   * subscribe initial frame 按 JSON-RPC request id 隔离。connection 必须先 take，
   * 再写 response line，最后按数组顺序写 notification，不能靠 microtask 猜时序。
   */
  private readonly postResponseOutbox = new Map<
    LCodeProtocolRequestId,
    LCodeProtocolPostResponseBatch
  >();

  constructor(deps: LCodeProtocolAgentDependencies) {
    this.runtimeResources = new ProtocolRuntimeResources(deps.createLCodeApp);
    const resolvedDeps = {
      ...deps,
      createLCodeApp: this.runtimeResources.create,
      // 默认 turn 窗口保留策略。
      createSessionEventStore:
        deps.createSessionEventStore ?? (() => createInMemorySessionEventStore()),
      workspaceHookPolicyProvider:
        deps.workspaceHookPolicyProvider ?? new InMemoryWorkspaceHookPolicyProvider(),
    };
    this.logger = createProtocolLogger(resolvedDeps);
    this.context = {
      assertServing: () => this.runtimeResources.assertServing(),
      deps: resolvedDeps,
      logger: this.logger,
      appRuntimePreferences: {
        askUserQuestionAutoResolutionEnabled: true,
        modelIoFullRetentionEnabled: false,
        offPeakToolEnabled: false,
        // 动态工作流灰度门 fail-closed：Host 必须显式 workspace/updateDynamicWorkflowPolicy
        // 才开启。
        dynamicWorkflowEnabled: false,
      },
      notify: (notification) => this.clientRequests.messageSink?.(notification),
      requestClient: (method, params, resultSchema, options) =>
        this.requestClient(method, params, resultSchema, options),
      sessions: new Map<string, LCodeProtocolSessionRecord>(),
      // 交互应答登记表（broker 反向请求 × v4 resolveInteraction 命令的汇合点）。
      v4Interactions: new V4InteractionRegistry(
        resolveV4InteractionRegistryOptionsFromEnv(deps.env ?? process.env),
      ),
    };
    // v4 通道：gateway 闭包持有 context 做帧出口与命令副作用，构造完立即挂回。
    this.context.v4Gateway = createConversationV4Gateway(this.context);
    this.browserControlPort = createProtocolBrowserControlBroker(this.context);
    const sessionResidentTargetCount =
      deps.sessionResidentPoolOptions?.targetCount ?? deps.sessionResidentTargetCount;
    const sessionResidentHighWaterCount =
      deps.sessionResidentPoolOptions?.highWaterCount ??
      (sessionResidentTargetCount === undefined
        ? undefined
        : Math.max(DEFAULT_SESSION_RESIDENT_HIGH_WATER_COUNT, sessionResidentTargetCount));
    // 单 CLI resident session 池：协议 request release 主动收敛，资源 sampler 只作兜底。
    this.context.sessionResidentPool = new SessionResidentPool(
      createSessionResidentPoolHost(this.context),
      {
        ...deps.sessionResidentPoolOptions,
        // legacy target 曾同时覆盖 high/low，导致迟滞窗口塌为 0；只覆盖 low。
        // 仅配置 target 且超过默认 high 时抬升隐式 high，显式非法组合仍由 pool 拒绝。
        highWaterCount: sessionResidentHighWaterCount,
        targetCount: sessionResidentTargetCount,
      },
    );
  }

  /** 低频 sampler 兜底入口；正常收敛由每个协议 request 的 operation lease 释放触发。 */
  rebalanceResidentSessions(): void {
    this.context.sessionResidentPool?.rebalance();
  }

  /**
   * 借同一 60s 节拍做 event store 的时间兜底淘汰：
   * subagent 子 session 只有一个 turn，等不到下一个 turn_started，只能按时间清。返回淘汰条数。
   */
  pruneSessionEventStores(nowMs: number = Date.now()): number {
    let evicted = 0;
    for (const record of this.context.sessions.values()) {
      evicted += record.eventStore.pruneTransientEvents?.(nowMs) ?? 0;
    }
    return evicted;
  }

  /** 同一 60s 节拍：释放已终态、无订阅者、无 record 的 detached subagent child publisher。 */
  pruneDetachedChildPublishers(nowMs: number = Date.now()): number {
    return this.context.v4Gateway?.pruneDetachedChildPublishers(nowMs) ?? 0;
  }

  /**
   * 内存诊断计数器，随 60s 资源采样写本地日志。
   * 只读 Map.size / 数组长度，不触碰 session 状态；持久化 event store 不提供 getStats 时计 0。
   */
  collectMemoryDiagnostics(): Record<string, number> {
    let eventRows = 0;
    let eventEvicted = 0;
    let eventTransientRetained = 0;
    for (const record of this.context.sessions.values()) {
      const stats = record.eventStore.getStats?.();
      eventRows += stats?.events ?? 0;
      eventEvicted += stats?.evictedEvents ?? 0;
      eventTransientRetained += stats?.retainedTransient ?? 0;
    }
    const counters: Record<string, number> = {
      sessions: this.context.sessions.size,
      eventRows,
      eventEvicted,
      eventTransientRetained,
    };
    const v4 = this.context.v4Gateway?.collectMemoryDiagnostics();
    if (v4) {
      for (const [key, value] of Object.entries(v4)) {
        counters[`v4.${key}`] = value;
      }
    }
    return counters;
  }

  setNotificationSink(sink: (message: LCodeProtocolOutboundMessage) => void): void {
    this.runtimeResources.assertServing();
    this.clientRequests.clientDisconnectError = undefined;
    this.clientRequests.messageSink = sink;
  }

  disconnectClient(error: Error): void {
    this.clientRequests.clientDisconnectError = error;
    // 连接关闭后反向请求已不可能收到响应，必须先结束 pending，
    // 否则正在物化 Session 的 handler 会阻塞 connection 的关闭流程。
    const pendingRequests = new Set(this.clientRequests.pendingClientRequests.values());
    for (const pending of pendingRequests) {
      cleanupClientRequest(this.clientRequests, pending);
      pending.reject(error);
    }
  }

  /** 进程资源关闭，不使用会删除产品会话/发布 session.removed 的 session/close。 */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.runtimeResources.close();
    const error = new Error("LCode Protocol runtime stopping");
    this.disconnectClient(error);
    this.clientRequests.messageSink = undefined;
    this.clearPostResponseMessages();
    for (const controller of this.pluginOperationControllers.values()) controller.abort(error);
    for (const controller of this.workspaceGenerateTextControllers.values())
      controller.abort(error);
    for (const record of this.context.sessions.values()) {
      record.activeAbortController?.abort(error);
      try {
        record.unsubscribe?.();
      } catch {
        this.logger?.warn("Session unsubscribe failed during protocol shutdown", {
          event: "lcode_protocol.session.unsubscribe.failed",
        });
      }
    }
    return this.shutdownPromise;
  }

  /** app drain 有界结束后释放投影；即使某个 app.close 挂起也必须执行。 */
  disposeProjections(): void {
    this.context.v4Gateway?.dispose();
    this.context.sessions.clear();
  }

  /** 一次性取走某 request 的 post-response messages；重复 take 返回空数组。 */
  takePostResponseMessages(requestId: LCodeProtocolRequestId): LCodeProtocolOutboundMessage[] {
    const batch = this.takePostResponseBatch(requestId);
    batch?.commit();
    return [...(batch?.messages ?? [])];
  }

  /** production NDJSON 取完整 batch；只有全部 write 成功后才调 commit。 */
  takePostResponseBatch(requestId: LCodeProtocolRequestId): LCodeProtocolPostResponseBatch | null {
    const batch = this.postResponseOutbox.get(requestId) ?? null;
    this.postResponseOutbox.delete(requestId);
    return batch;
  }

  /** connection close / server dispose 时释放尚未写出的 initial frame 引用。 */
  clearPostResponseMessages(): void {
    this.postResponseOutbox.clear();
  }

  async handleMessage(
    message: LCodeProtocolMessage,
  ): Promise<LCodeProtocolError | LCodeProtocolResponse | undefined> {
    this.runtimeResources.assertServing();
    if (isResponse(message)) {
      resolveClientRequest(this.clientRequests, message.id, message.result);
      return undefined;
    }
    if (isErrorResponse(message)) {
      rejectClientRequest(
        this.clientRequests,
        message.id,
        new ProtocolRequestError(message.error.code, message.error.message, message.error.data),
      );
      return undefined;
    }
    if (isRequest(message)) {
      return await this.handleRequest(message);
    }
    if (isNotification(message)) {
      this.logger?.debug("LCode Protocol notification ignored", {
        event: "lcode_protocol.notification.ignored",
        method: message.method,
        module: "bootstrap.lcode_protocol",
      });
    }
    return undefined;
  }

  private async handleRequest(
    request: LCodeProtocolRequest,
  ): Promise<LCodeProtocolError | LCodeProtocolResponse> {
    // request id 可在前一请求完成后复用；新请求不能继承未消费的旧 outbox。
    this.postResponseOutbox.delete(request.id);
    let releaseResidencyOperation: (() => void) | undefined;
    try {
      // subscribe hydration、workspace 配置与 resume 都可能跨 await。若只看
      // session 当前状态，sampler 会在 handler 持有旧 record 时把它关闭。进程级 lease
      // 覆盖整个 request；能识别的 sessionIds 额外用于冷恢复闸门与 LRU touch。
      releaseResidencyOperation = await this.context.sessionResidentPool?.acquireOperation(
        collectResidencySessionIds(request.params),
      );
      const result = await this.dispatchRequest(request);
      return this.ok(request.id, result);
    } catch (error) {
      this.postResponseOutbox.delete(request.id);
      const protocolError = toProtocolError(error);
      return this.fail(request.id, protocolError.code, protocolError.message, protocolError.data);
    } finally {
      releaseResidencyOperation?.();
    }
  }

  private dispatchRequest(request: LCodeProtocolRequest) {
    return dispatchRequest(
      {
        context: this.context,
        postResponseOutbox: this.postResponseOutbox,
        pluginOperationControllers: this.pluginOperationControllers,
        workspaceGenerateTextControllers: this.workspaceGenerateTextControllers,
      },
      request,
    );
  }

  private ok(id: LCodeProtocolRequestId, result: unknown): LCodeProtocolResponse {
    return { id, result };
  }

  private fail(
    id: LCodeProtocolRequestId,
    code: number,
    message: string,
    data?: unknown,
  ): LCodeProtocolError {
    return { error: { code, data, message }, id };
  }

  private requestClient<T>(
    method: LCodeProtocolMethod,
    params: unknown,
    resultSchema: ParamsSchema<T>,
    options?: LCodeProtocolClientRequestOptions,
  ): Promise<T> {
    return requestClient(this.clientRequests, method, params, resultSchema, options);
  }
}
