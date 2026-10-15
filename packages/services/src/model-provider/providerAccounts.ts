import {
  PROVIDER_AUTH_CHANNELS,
  loadProviderAuthChannels,
  projectProviderAccount,
  modelSchema,
  type StoredAccount,
} from "./providerAccountStoreSchema.js";
import { executeProviderAccountPool } from "./providerAccountPool.js";
import { resolveProviderAccountRoutes } from "./providerAccountRouting.js";
import { createProviderAccountContext } from "./providerAccountContext.js";
import { ProviderAccountQuotas } from "./providerAccountQuotas.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Emitter } from "@lcode/rpc";
import { ProviderAccountRefreshOwner } from "./providerAccountRefreshOwner.js";
import { ProviderAccountDriverCleanup } from "./providerAccountDriverCleanup.js";
import { prepareProviderAuthorizationInputs } from "./providerAccountAuthorizationInputs.js";
import {
  startProviderAuthorizationSchema,
  type ProviderAccountChannel,
  type ProviderAccountView,
  type ProviderAuthorization,
  type StartProviderAuthorization,
} from "@lcode/shared";
import {
  createAuthDriver,
  type AuthDriver,
  type AuthDriverFactory,
  type AuthWireProtocol,
} from "@lcode/provider-node";
import type { ICredentialService } from "../credential/credential.js";
import type { IProviderAccountService } from "./providerAccountService.js";
import { ProviderAccountTransport } from "./providerAccountTransport.js";
import {
  ProviderAccountStorage,
  watchProviderAccountStorage,
  authorizationFailureMessage,
} from "./providerAccountStorage.js";
import {
  completeProviderAccountAuthorization,
  type AccountAuthorizationAttempt as Attempt,
} from "./providerAccountCompletion.js";
export interface ProviderAccountsOptions {
  credentials: ICredentialService;
  lockPath: string;
  watchFile?: string;
  factory?: AuthDriverFactory;
  channels?: readonly { id: string; name: string }[];
}

export class ProviderAccounts implements IProviderAccountService {
  readonly #emitter = new Emitter<ProviderAccountView>();
  readonly onDidChange = this.#emitter.event;
  readonly #attempts = new Map<string, Attempt>();
  readonly #starting = new Map<AuthDriver, AbortController>();
  readonly #drivers = new Map<string, AuthDriver>();
  readonly #inflight = new Map<string, Set<AbortController>>();
  readonly #refreshOwner: ProviderAccountRefreshOwner;
  readonly #driverCleanup = new ProviderAccountDriverCleanup();
  readonly #operations = {
    read: () => this.#storage.read(),
    driver: (account: StoredAccount) => this.#driver(account),
    context: (account: StoredAccount, signal: AbortSignal) => this.#context(account, signal),
    track: (id: string) => this.#track(id),
    untrack: (id: string, controller: AbortController) => this.#untrack(id, controller),
    withAccountLock: <T>(account: StoredAccount, operation: () => Promise<T>) =>
      this.#withAccountLock(account, operation),
    preferred: new Map<string, string>(),
    closed: () => this.#disposed,
  };
  readonly #quotas = new ProviderAccountQuotas(this.#operations);
  readonly #transport = new ProviderAccountTransport((ticket, request) =>
    executeProviderAccountPool(
      this.#operations,
      ticket.channelId,
      ticket.modelId,
      ticket.protocol,
      request,
    ),
  );
  #channels?: Promise<readonly ProviderAccountChannel[]>;
  #revision = 0;
  #disposed = false;
  readonly #storage: ProviderAccountStorage;
  readonly #watcher: { ready: Promise<void>; dispose: () => void };
  #publishedSignature?: string;
  constructor(private readonly options: ProviderAccountsOptions) {
    this.#refreshOwner = new ProviderAccountRefreshOwner(options.lockPath);
    this.#storage = new ProviderAccountStorage(options.credentials, options.lockPath);
    this.#watcher = watchProviderAccountStorage(options.watchFile, async () => {
      const accounts = await this.#storage.readPublic();
      const signature = JSON.stringify(accounts);
      if (!this.#disposed && signature !== this.#publishedSignature) {
        this.#publishedSignature = signature;
        this.#revision++;
        await this.#publish();
      }
    });
  }
  get #factory(): AuthDriverFactory {
    return this.options.factory ?? createAuthDriver;
  }
  async #mutate(update: (accounts: StoredAccount[]) => void): Promise<void> {
    await this.#storage.mutate((accounts) => {
      if (this.#disposed) throw new Error("Provider account service closed");
      update(accounts);
    });
    this.#revision++;
  }
  async getView(): Promise<ProviderAccountView> {
    await this.#watcher.ready;
    const channels = await (this.#channels ??= loadProviderAuthChannels(
      this.options.channels ?? PROVIDER_AUTH_CHANNELS,
      this.#factory,
    ));
    // 读取前冻结版本，旧快照不能冒用渠道初始化期间产生的新版本覆盖新视图。
    const revision = this.#revision;
    const stored = await this.#storage.read();
    const accounts = stored.map(projectProviderAccount);
    return { revision, channels, accounts };
  }
  async #publish(): Promise<ProviderAccountView> {
    const view = await this.getView();
    if (!this.#disposed) this.#emitter.fire(view);
    return view;
  }
  async startAuthorization(input: StartProviderAuthorization): Promise<ProviderAuthorization> {
    await this.#watcher.ready;
    if (this.#disposed) throw new Error("Provider account service closed");
    const parsed = startProviderAuthorizationSchema.parse(input);
    const channel = (this.options.channels ?? PROVIDER_AUTH_CHANNELS).find(
      (item) => item.id === parsed.channelId,
    );
    if (!channel) throw new Error("Unknown authorization channel");
    const { driver, controller } = await this.#driverCleanup.constructDriver({
      create: () => this.#factory(parsed.channelId),
      closed: () => this.#disposed,
      publish: (driver) => {
        const controller = new AbortController();
        this.#starting.set(driver, controller);
        return { driver, controller };
      },
    });
    try {
      if (this.#disposed) throw new Error("Provider account service closed");
      const method = (await driver.methods()).find((item) => item.id === parsed.methodId);
      if (!method) throw new Error("Unknown authorization method");
      const inputs = prepareProviderAuthorizationInputs(method, parsed.inputs);
      if (channel.id === "chatgpt-api") inputs.hostId = await this.#storage.hostId();
      controller.signal.throwIfAborted();
      const challenge = await driver.authorize(parsed.methodId, inputs, controller.signal);
      if (this.#disposed || controller.signal.aborted) {
        challenge.cancel?.();
        throw new Error("Authorization cancelled");
      }
      const view: ProviderAuthorization = {
        attemptId: randomUUID(),
        channelId: parsed.channelId,
        methodId: parsed.methodId,
        status: "pending",
        method: challenge.method,
        ...(challenge.url ? { url: challenge.url } : {}),
        ...(challenge.instructions ? { instructions: challenge.instructions } : {}),
      };
      const attempt: Attempt = { view, controller, driver, challenge };
      this.#attempts.set(view.attemptId, attempt);
      if (challenge.method === "auto") attempt.completion = this.#complete(attempt);
      return { ...view };
    } catch (error) {
      controller.abort();
      await this.#driverCleanup.retire(driver);
      throw new Error(authorizationFailureMessage(error));
    } finally {
      this.#starting.delete(driver);
    }
  }
  async getAuthorization(attemptId: string): Promise<ProviderAuthorization> {
    return { ...this.#attempt(attemptId).view };
  }
  #attempt(id: string): Attempt {
    const attempt = this.#attempts.get(id);
    if (!attempt) throw new Error("Unknown authorization attempt");
    return attempt;
  }
  async completeAuthorization(attemptId: string, code: string): Promise<ProviderAuthorization> {
    const attempt = this.#attempt(attemptId);
    if (attempt.view.status === "pending") {
      attempt.completion ??= this.#complete(attempt, code);
      await attempt.completion;
    }
    return { ...attempt.view };
  }
  async #complete(attempt: Attempt, code?: string): Promise<void> {
    await completeProviderAccountAuthorization(
      {
        closed: () => this.#disposed,
        channel: (id) =>
          (this.options.channels ?? PROVIDER_AUTH_CHANNELS).find((channel) => channel.id === id)!,
        mutate: (update) => this.#mutate(update),
        rollback: (update) => this.#storage.mutate(update),
        resetDriver: async (id) => {
          this.#abort(id);
          await this.#drivers.get(id)?.dispose?.();
          this.#drivers.delete(id);
        },
        useDriver: (id, driver) => {
          this.#drivers.set(id, driver);
        },
        refreshEnabled: async (id) => {
          if (
            (await this.#storage.read()).some(
              (account) => account.connectionId === id && account.enabled,
            )
          )
            await this.refreshModels(id);
        },
        publish: () => this.#publish(),
      },
      attempt,
      code,
    );
  }
  async cancelAuthorization(attemptId: string): Promise<ProviderAuthorization> {
    const attempt = this.#attempt(attemptId);
    if (attempt.view.status !== "pending") return { ...attempt.view };
    attempt.controller.abort();
    attempt.challenge.cancel?.();
    attempt.view = { ...attempt.view, status: "cancelled" };
    await attempt.driver.dispose?.();
    return { ...attempt.view };
  }
  async #driver(account: StoredAccount): Promise<AuthDriver> {
    let driver = this.#drivers.get(account.connectionId);
    if (!driver) {
      driver = await this.#driverCleanup.constructDriver({
        create: () => this.#factory(account.channelId),
        closed: () => this.#disposed,
        validate: async () =>
          (await this.#storage.read()).some(
            (item) => item.connectionId === account.connectionId && item.enabled,
          ),
        publish: (created) => {
          this.#drivers.set(account.connectionId, created);
          return created;
        },
      });
    }
    return driver;
  }
  #context(
    account: StoredAccount,
    signal?: AbortSignal,
  ): ReturnType<typeof createProviderAccountContext> {
    const context = createProviderAccountContext(
      { read: () => this.#storage.read(), mutate: (update) => this.#mutate(update) },
      account,
      signal,
      () => !this.#disposed,
    );
    return {
      ...context,
      retainRefreshCompletion: (completion) =>
        this.#refreshOwner.retain(account.connectionId, completion),
      reportSignIn: async (status) => {
        await context.reportSignIn?.(status);
        await this.#publish();
      },
    };
  }
  async refreshModels(connectionId: string): Promise<ProviderAccountView> {
    const account = (await this.#storage.read()).find((item) => item.connectionId === connectionId);
    if (!account) throw new Error("Unknown account");
    const controller = this.#track(connectionId);
    const context = this.#context(account, controller.signal);
    try {
      const catalog = await this.#withAccountLock(account, async () => {
        controller.signal.throwIfAborted();
        const driver = await this.#driver(account);
        return driver.modelCatalog
          ? driver.modelCatalog(context)
          : { models: await driver.models(context), fallback: false };
      });
      const models = z.array(modelSchema).parse(catalog.models);
      await this.#mutate((accounts) => {
        controller.signal.throwIfAborted();
        const current = accounts.find((item) => item.connectionId === connectionId);
        // 其他Host重新授权时本地controller未必已取消；目录也必须检查本次实际读取/刷新的凭据代次。
        if (!current || !context.isCurrent(current)) throw new Error("Stale model catalog");
        // 插件短期兜底目录不是新事实；成功目录不能被静态fallback静默缩水。
        if (!catalog.fallback || !current.models.length) current.models = models;
        if (catalog.fallback)
          current.error = "Model catalog unavailable; showing the last available models.";
        else delete current.error;
      });
    } catch {
      if (!controller.signal.aborted)
        await this.#mutate((accounts) => {
          const current = accounts.find((item) => item.connectionId === connectionId);
          if (current && context.isCurrent(current))
            current.error = "Unable to load models. Refresh or sign in again.";
        });
    } finally {
      this.#untrack(connectionId, controller);
    }
    return this.#publish();
  }
  #track(id: string): AbortController {
    const controller = new AbortController();
    let set = this.#inflight.get(id);
    if (!set) {
      set = new Set();
      this.#inflight.set(id, set);
    }
    set.add(controller);
    return controller;
  }
  getQuota(connectionId: string, force?: boolean) {
    return this.#quotas.get(connectionId, force);
  }
  #untrack(id: string, controller: AbortController): void {
    const set = this.#inflight.get(id);
    set?.delete(controller);
    if (!set?.size) this.#inflight.delete(id);
  }
  #abort(id: string): void {
    this.#quotas.invalidate(id);
    for (const controller of this.#inflight.get(id) ?? []) controller.abort();
    this.#inflight.delete(id);
  }
  async removeAccount(connectionId: string): Promise<ProviderAccountView> {
    await this.#mutate((accounts) => {
      const index = accounts.findIndex((item) => item.connectionId === connectionId);
      if (index >= 0) accounts.splice(index, 1);
    });
    this.#abort(connectionId);
    await this.#drivers.get(connectionId)?.dispose?.();
    this.#drivers.delete(connectionId);
    return this.#publish();
  }
  async setAccountEnabled(connectionId: string, enabled: boolean): Promise<ProviderAccountView> {
    if (typeof enabled !== "boolean") throw new Error("Invalid account enabled state");
    await this.#mutate((accounts) => {
      const account = accounts.find((item) => item.connectionId === connectionId);
      if (!account) throw new Error("Unknown account");
      account.enabled = enabled;
      account.generation++;
    });
    if (!enabled) this.#abort(connectionId);
    return this.#publish();
  }
  readonly readAccounts = () => this.#storage.readPublic();
  channelName(id: string): string {
    return (
      (this.options.channels ?? PROVIDER_AUTH_CHANNELS).find((channel) => channel.id === id)
        ?.name ?? id
    );
  }
  async resolveRequestAuth(
    channelId: string,
    modelId: string,
    protocol: AuthWireProtocol | undefined,
    sessionId?: string,
  ) {
    const selectedProtocol = resolveProviderAccountRoutes(
      await this.#storage.read(),
      channelId,
      modelId,
      protocol,
    )[0]?.model.protocol;
    if (!selectedProtocol) throw new Error("No authorized account supports this model");
    return {
      ...(await this.#transport.issue(channelId, modelId, selectedProtocol, sessionId)),
      protocol: selectedProtocol,
    };
  }
  #withAccountLock<T>(account: StoredAccount, operation: () => Promise<T>): Promise<T> {
    return this.#refreshOwner.run(account.connectionId, operation);
  }
  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#quotas.dispose();
    this.#watcher.dispose();
    for (const controller of this.#starting.values()) controller.abort();
    for (const attempt of this.#attempts.values()) {
      attempt.controller.abort();
      attempt.challenge.cancel?.();
    }
    for (const id of this.#inflight.keys()) this.#abort(id);
    this.#transport.dispose();
    await this.#driverCleanup.close([
      ...this.#drivers.values(),
      ...this.#starting.keys(),
      ...[...this.#attempts.values()].map((item) => item.driver),
    ]);
    this.#emitter.dispose();
  }
}
