import { randomUUID } from "node:crypto";
import { Emitter, type IDisposable } from "@lcode/rpc";
import {
  providerAccountRelayHeadSchema,
  providerAccountRelayChunkSchema,
  type ProviderAccountView,
  type RoutingInvocation,
  type ProviderRoutingPolicy,
} from "@lcode/shared";
import type { AuthWireProtocol } from "@lcode/provider-node";
import type { IProviderAccountService } from "./providerAccountService.js";
import type { ProviderAccountRelayService } from "./providerAccountRelay.js";
import { ProviderAccountTransport } from "./providerAccountTransport.js";
import { resolveProviderAccountRoutes } from "./providerAccountRouting.js";

/** 远端只派生公开模型与本机 owner 的调用能力；不创建第二份 OAuth 凭据。 */
export class RemoteProviderAccounts implements IProviderAccountService {
  readonly #emitter = new Emitter<ProviderAccountView>();
  readonly onDidChange = this.#emitter.event;
  readonly #ready: Promise<ProviderAccountRelayService>;
  #resolve!: (service: ProviderAccountRelayService) => void;
  #reject!: (error: Error) => void;
  #subscription?: IDisposable;
  #attached = false;
  #disposed = false;
  readonly #channelNames = new Map<string, string>();
  readonly #routingRequests = new WeakMap<object, string>();
  readonly #transport = new ProviderAccountTransport(
    async (ticket, request) => {
      const relay = await this.#ready;
      const requestId = randomUUID();
      const cancel = () => {
        void relay.cancel(requestId).catch(() => {});
      };
      const cleanup = () => request.signal.removeEventListener("abort", cancel);
      request.signal.throwIfAborted();
      request.signal.addEventListener("abort", cancel, { once: true });
      try {
        const body = Buffer.from(await request.arrayBuffer()).toString("base64");
        request.signal.throwIfAborted();
        const headers: Record<string, string> = {};
        for (const name of ["anthropic-version", "anthropic-beta", "accept"]) {
          const value = request.headers.get(name);
          if (value) headers[name] = value;
        }
        const head = providerAccountRelayHeadSchema.parse(
          await relay.open({
            requestId,
            channelId: ticket.channelId,
            modelId: ticket.modelId,
            protocol: ticket.protocol,
            ...(ticket.sessionId ? { sessionId: ticket.sessionId } : {}),
            ...(ticket.routingInvocation ? { routingInvocation: ticket.routingInvocation } : {}),
            body,
            headers,
          }),
        );
        if (head.headers["x-zcode-routing-strategy"]) this.#routingRequests.set(ticket, requestId);
        request.signal.throwIfAborted();
        if ([204, 205, 304].includes(head.status)) {
          cleanup();
          await relay.cancel(requestId);
          return new Response(null, head);
        }
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = providerAccountRelayChunkSchema.parse(await relay.read(requestId));
              request.signal.throwIfAborted();
              if (chunk.done) {
                cleanup();
                controller.close();
              } else controller.enqueue(Buffer.from(chunk.data, "base64"));
            } catch {
              cleanup();
              cancel();
              controller.error(new Error("OAuth relay response unavailable"));
            }
          },
          cancel() {
            cleanup();
            cancel();
          },
        });
        return new Response(stream, head);
      } catch {
        cleanup();
        cancel();
        throw new Error("OAuth relay model request failed");
      }
    },
    async (ticket, usage) => {
      const id = this.#routingRequests.get(ticket);
      if (this.#disposed) throw new Error("owner-stale");
      if (!id) return;
      const relay = await this.#ready;
      if (!relay.observeRoutingUsage) throw new Error("routing-capability-required");
      await relay.observeRoutingUsage(id, usage);
    },
  );
  constructor(
    private readonly options: {
      readRouting?: (channel: string) => Promise<ProviderRoutingPolicy | null | undefined>;
    } = {},
  ) {
    this.#ready = new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    void this.#ready.catch(() => {});
  }
  attach(service: ProviderAccountRelayService): void {
    if (this.#attached || this.#disposed) throw new Error("OAuth relay attachment unavailable");
    this.#attached = true;
    this.#subscription = service.onDidChange((view) => {
      if (!this.#disposed) this.#emitter.fire(view);
    });
    this.#resolve(service);
  }
  async getView() {
    const view = await (await this.#ready).getView();
    if (this.#disposed) throw new Error("OAuth relay closed");
    for (const channel of view.channels) this.#channelNames.set(channel.id, channel.name);
    return view;
  }
  startAuthorization: IProviderAccountService["startAuthorization"] = async (input) =>
    (await this.#ready).startAuthorization(input);
  getAuthorization: IProviderAccountService["getAuthorization"] = async (id) =>
    (await this.#ready).getAuthorization(id);
  completeAuthorization: IProviderAccountService["completeAuthorization"] = async (id, code) =>
    (await this.#ready).completeAuthorization(id, code);
  cancelAuthorization: IProviderAccountService["cancelAuthorization"] = async (id) =>
    (await this.#ready).cancelAuthorization(id);
  refreshModels: IProviderAccountService["refreshModels"] = async (id) =>
    (await this.#ready).refreshModels(id);
  checkinAccount: IProviderAccountService["checkinAccount"] = async (id) =>
    (await this.#ready).checkinAccount(id);
  checkinAll: IProviderAccountService["checkinAll"] = async (channel) =>
    (await this.#ready).checkinAll(channel);
  setAutomaticCheckin: IProviderAccountService["setAutomaticCheckin"] = async (id, enabled) =>
    (await this.#ready).setAutomaticCheckin(id, enabled);
  getQuota: IProviderAccountService["getQuota"] = async (id, force) =>
    (await this.#ready).getQuota(id, force);
  removeAccount: IProviderAccountService["removeAccount"] = async (id) =>
    (await this.#ready).removeAccount(id);
  setAccountEnabled: IProviderAccountService["setAccountEnabled"] = async (id, enabled) =>
    (await this.#ready).setAccountEnabled(id, enabled);
  readonly readAccounts = async () =>
    (await this.getView()).accounts.map((account) => ({
      ...account,
      models: account.models.map((model) => ({ ...model, baseURL: "https://oauth.invalid/v1" })),
    }));
  channelName(id: string): string {
    return this.#channelNames.get(id) ?? id;
  }
  async resolveRequestAuth(
    channelId: string,
    modelId: string,
    protocol?: AuthWireProtocol,
    sessionId?: string,
    routingInvocation?: RoutingInvocation,
  ) {
    const service = await this.#ready;
    const policy = await this.options.readRouting?.(channelId);
    const capabilities = await service
      .getRoutingCapabilities?.()
      .catch((): readonly string[] => []);
    if (policy && (!routingInvocation || !capabilities?.includes("single-attempt-routing-v1")))
      throw new Error("routing-capability-required");
    // 手动模型与目录内模型复用本机路由规则，不能在远端再维护一套账号资格判断。
    const model = resolveProviderAccountRoutes(
      await this.readAccounts(),
      channelId,
      modelId,
      protocol,
    )[0]?.model;
    if (!model) throw new Error("No authorized account supports this model");
    return {
      ...(await this.#transport.issue(
        channelId,
        modelId,
        model.protocol,
        sessionId,
        capabilities?.includes("single-attempt-routing-v1") ? routingInvocation : undefined,
      )),
      protocol: model.protocol,
      ...(routingInvocation && capabilities?.includes("single-attempt-routing-v1")
        ? { routingFeedback: true as const }
        : {}),
    };
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#reject(new Error("OAuth relay closed"));
    this.#subscription?.dispose();
    this.#transport.dispose();
    this.#emitter.dispose();
  }
}
