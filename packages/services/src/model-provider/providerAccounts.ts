import {
  PROVIDER_AUTH_CHANNELS,
  loadProviderAuthChannels,
  projectProviderAccount,
  type StoredAccount,
} from "./providerAccountStoreSchema.js";
import { executeProviderAccountPool } from "./providerAccountPool.js";
import {
  resolveProviderAccountRequestAuth,
  type ProviderAccountRequestAuthArgs,
} from "./providerAccountRequestAuth.js";
import { createProviderAccountContext } from "./providerAccountContext.js";
import { ProviderAccountQuotas } from "./providerAccountQuotas.js";
import { ProviderAccountScheduler } from "./providerAccountScheduler.js";
import type { ProviderRoutingPolicy } from "@lcode/shared";
import { ProviderAccountCheckins } from "./providerAccountCheckins.js";
import { refreshProviderAccountCatalog } from "./providerAccountCatalogRefresh.js";
import { randomUUID } from "node:crypto";
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
import { createAuthDriver, type AuthDriver, type AuthDriverFactory } from "@lcode/provider-node";
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
  readRouting?: (channelId: string) => Promise<ProviderRoutingPolicy | null | undefined>;
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
      this.#refreshOwner.run(account.connectionId, operation),
    preferred: new Map<string, string>(),
    closed: () => this.#disposed,
  };
  readonly #quotas = new ProviderAccountQuotas(this.#operations);
  readonly #routing = new ProviderAccountScheduler(
    (channel) => this.options.readRouting?.(channel) ?? Promise.resolve(undefined),
    this.#quotas,
  );
  readonly #checkins: ProviderAccountCheckins;
  readonly #transport = new ProviderAccountTransport(
    (ticket, request) =>
      executeProviderAccountPool(
        this.#operations,
        ticket.channelId,
        ticket.modelId,
        ticket.protocol,
        request,
        this.#routing,
        ticket.routingInvocation,
      ),
    (ticket, usage) => {
      if (ticket.routingInvocation) this.#routing.observeUsage(ticket.routingInvocation, usage);
    },
  );
  #channels?: Promise<readonly ProviderAccountChannel[]>;
  #revision = 0;
  #disposed = false;
  readonly #storage: ProviderAccountStorage;
  readonly #factory: AuthDriverFactory;
  readonly #watcher: { ready: Promise<void>; dispose: () => void };
  #publishedSignature?: string;
  constructor(private readonly options: ProviderAccountsOptions) {
    this.#factory = options.factory ?? createAuthDriver;
    this.#refreshOwner = new ProviderAccountRefreshOwner(options.lockPath);
    this.#storage = new ProviderAccountStorage(options.credentials, options.lockPath);
    this.#checkins = new ProviderAccountCheckins({
      ...this.#operations,
      mutate: (update) => this.#mutate(update),
      publish: () => this.#publish(),
      invalidateQuota: (id) => this.#quotas.invalidate(id),
      supportsCheckin: async (id) =>
        (await this.getView()).channels.some(
          (channel) => channel.id === id && channel.checkinSupported,
        ),
      activityChanged: () => {
        this.#revision++;
      },
    });
    this.#checkins.start();
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
    const accounts = stored.map((account) =>
      projectProviderAccount(account, this.#checkins.isRunning(account.connectionId)),
    );
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
    return refreshProviderAccountCatalog(
      {
        ...this.#operations,
        mutate: (update) => this.#mutate(update),
        publish: () => this.#publish(),
      },
      connectionId,
    );
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
  async checkinAccount(id: string) {
    await this.#checkins.run(id);
    return this.#publish();
  }
  async checkinAll(channelId?: string) {
    await this.#checkins.runAll(channelId);
    return this.#publish();
  }
  async setAutomaticCheckin(id: string, enabled: boolean) {
    await this.#checkins.setAutomatic(id, enabled);
    return this.#publish();
  }
  #untrack(id: string, controller: AbortController): void {
    const set = this.#inflight.get(id);
    set?.delete(controller);
    if (!set?.size) this.#inflight.delete(id);
  }
  #abort(id: string): void {
    this.#checkins.invalidate(id);
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
      account.routingEpoch = (account.routingEpoch ?? 0) + 1;
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
  readonly resolveRequestAuth = (...args: ProviderAccountRequestAuthArgs) =>
    resolveProviderAccountRequestAuth(this.#storage, this.#routing, this.#transport, ...args);
  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#quotas.dispose();
    this.#routing.dispose();
    this.#checkins.dispose();
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
