import {
  ProviderConfigService,
  type ProviderConfigLayerSnapshot,
  type ProviderConfigLayerUpdate,
} from "@lcode/provider";
import { NodeLCodeBuiltinProviderConfigSource } from "./lcode-builtin-provider-config-source.js";
import {
  EndpointScopedLCodeBuiltinSource,
  type EndpointScopedLCodeBuiltinSourceOptions,
} from "./endpoint-scoped-lcode-builtin-source.js";
import {
  LCodeBuiltinRemoteSynchronizer,
  type LCodeBuiltinRemoteSynchronizerOptions,
  type LCodeBuiltinRefreshResult,
} from "./lcode-builtin-remote-synchronizer.js";
import {
  NodePersonalProviderConfigRepository,
  type PersonalProviderConfigRecoveryEvent,
} from "./personal-provider-config-repository.js";

export interface NodeProviderConfigRuntimeOptions {
  readonly lcodeBuiltinFilePath: string;
  readonly lcodeBuiltinActiveFilePath?: string;
  readonly lcodeBuiltinRemote?: Omit<LCodeBuiltinRemoteSynchronizerOptions, "source">;
  readonly lcodeBuiltinEnvironment?: Omit<
    EndpointScopedLCodeBuiltinSourceOptions,
    "bundledFilePath"
  >;
  readonly onLCodeBuiltinRefreshError?: (error: unknown) => void;
  readonly onPersonalConfigRecovery?: (event: PersonalProviderConfigRecoveryEvent) => void;
  readonly onPersonalConfigPollingError?: (error: unknown) => void;
  readonly personalFilePath: string;
  readonly personalPollingIntervalMs?: number | false;
  readonly importLegacy?: (
    lcodeBuiltin: ProviderConfigLayerSnapshot,
  ) => Promise<ProviderConfigLayerUpdate | null>;
  readonly watch?: boolean;
}

/** 组装一个 Node.js 进程内共享的 LCode Built-in/Personal Config 运行边界。 */
export class NodeProviderConfigRuntime {
  readonly configService: ProviderConfigService;
  readonly #lcodeBuiltinSource:
    | NodeLCodeBuiltinProviderConfigSource
    | EndpointScopedLCodeBuiltinSource;
  readonly #personalRepository: NodePersonalProviderConfigRepository;
  readonly #remoteSynchronizer?: LCodeBuiltinRemoteSynchronizer;
  readonly #onRemoteRefreshError?: (error: unknown) => void;
  #startPromise: Promise<void> | null = null;
  #disposed = false;
  readonly #checkListeners = new Set<() => Promise<void>>();
  #checkTimer: ReturnType<typeof setInterval> | null = null;
  #checkInFlight: Promise<void> | null = null;

  constructor(options: NodeProviderConfigRuntimeOptions) {
    this.#lcodeBuiltinSource = options.lcodeBuiltinEnvironment
      ? new EndpointScopedLCodeBuiltinSource({
          bundledFilePath: options.lcodeBuiltinFilePath,
          ...options.lcodeBuiltinEnvironment,
        })
      : new NodeLCodeBuiltinProviderConfigSource({
          bundledFilePath: options.lcodeBuiltinFilePath,
          activeFilePath: options.lcodeBuiltinActiveFilePath,
          watch: options.watch,
        });
    this.#remoteSynchronizer =
      options.lcodeBuiltinRemote &&
      this.#lcodeBuiltinSource instanceof NodeLCodeBuiltinProviderConfigSource
        ? new LCodeBuiltinRemoteSynchronizer({
            source: this.#lcodeBuiltinSource,
            ...options.lcodeBuiltinRemote,
          })
        : undefined;
    this.#onRemoteRefreshError = options.onLCodeBuiltinRefreshError;
    this.#personalRepository = new NodePersonalProviderConfigRepository({
      filePath: options.personalFilePath,
      onRecovery: options.onPersonalConfigRecovery,
      onPollingError: options.onPersonalConfigPollingError,
      pollingIntervalMs: options.personalPollingIntervalMs,
      ...(options.importLegacy
        ? {
            importLegacy: async () => options.importLegacy!(await this.#lcodeBuiltinSource.read()),
          }
        : {}),
    });
    this.configService = new ProviderConfigService({
      lcodeBuiltinSource: this.#lcodeBuiltinSource,
      personalRepository: this.#personalRepository,
    });
  }

  resolveLCodeBuiltinActiveFilePath(): Promise<string> {
    return this.#lcodeBuiltinSource instanceof NodeLCodeBuiltinProviderConfigSource
      ? Promise.resolve(this.#lcodeBuiltinSource.activeFilePath)
      : this.#lcodeBuiltinSource.resolveActiveFilePath();
  }

  get personalRepository(): import("@lcode/provider").PersonalProviderConfigRepository {
    return this.#personalRepository;
  }

  /** Environment 同一周期检查中恢复未对齐依赖，不被下载 TTL 或失败挡住。 */
  onDidCheckLCodeBuiltin(listener: () => Promise<void>): () => void {
    this.#checkListeners.add(listener);
    return () => this.#checkListeners.delete(listener);
  }

  start(): Promise<void> {
    if (this.#disposed) throw new Error("NodeProviderConfigRuntime 已 dispose");
    if (this.#startPromise) return this.#startPromise;
    const startPromise = this.configService.read().then(() => {
      if (this.#disposed) return;
      void this.#checkBackground();
      // Managed Worker 无下载配置也无恢复 owner，不建立周期任务。
      if (
        this.#remoteSynchronizer ||
        this.#lcodeBuiltinSource instanceof EndpointScopedLCodeBuiltinSource ||
        this.#checkListeners.size > 0
      ) {
        this.#checkTimer = setInterval(() => {
          void this.#checkBackground();
        }, 60_000);
        this.#checkTimer.unref?.();
      }
    });
    this.#startPromise = startPromise;
    void startPromise.catch(() => {
      if (this.#startPromise === startPromise) this.#startPromise = null;
    });
    return startPromise;
  }

  refreshLCodeBuiltin(options?: { readonly force?: boolean }): Promise<LCodeBuiltinRefreshResult> {
    if (this.#disposed) return Promise.resolve("disposed");
    if (this.#lcodeBuiltinSource instanceof EndpointScopedLCodeBuiltinSource) {
      return this.#lcodeBuiltinSource.refresh(options);
    }
    return this.#remoteSynchronizer?.refresh(options) ?? Promise.resolve("skipped");
  }

  #checkBackground(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#checkInFlight) return this.#checkInFlight;
    const check = Promise.allSettled([
      this.refreshLCodeBuiltin(),
      ...[...this.#checkListeners].map((listener) => Promise.resolve().then(listener)),
    ])
      .then((results) => {
        if (this.#disposed) return;
        for (const result of results)
          if (result.status === "rejected") this.#onRemoteRefreshError?.(result.reason);
      })
      .finally(() => {
        if (this.#checkInFlight === check) this.#checkInFlight = null;
      });
    this.#checkInFlight = check;
    return check;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#checkTimer) clearInterval(this.#checkTimer);
    this.#checkTimer = null;
    this.#checkListeners.clear();
    this.#remoteSynchronizer?.dispose();
    this.configService.dispose();
    this.#personalRepository.dispose();
    this.#lcodeBuiltinSource.dispose();
  }
}

export function createNodeProviderConfigRuntime(
  options: NodeProviderConfigRuntimeOptions,
): NodeProviderConfigRuntime {
  return new NodeProviderConfigRuntime(options);
}
