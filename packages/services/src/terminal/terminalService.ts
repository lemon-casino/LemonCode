import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Emitter, type Event, type IDisposable } from "@lcode/rpc";
import type { IPty } from "node-pty";
import type { ISettingService } from "../setting/setting.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import {
  terminalCreateParamsSchema,
  type ITerminalService,
  type RuntimeTerminalEnvironmentLease,
  type RuntimeTerminalEnvironmentPort,
  type RuntimeTerminalScope,
  type TerminalCreateParams,
} from "./terminal.js";
import { resolveTerminalFontProfile } from "./terminalProfile.js";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";
import { resolveConfiguredTerminalShell } from "./terminalShellSelection.js";
import { isOwnedCheckoutScope } from "../process/ownedCheckoutScope.js";
import {
  applyTerminalEnvironment,
  ensureNodePtySpawnHelperExecutable,
  errorMessage,
  loadNodePtyModule,
  resolveTerminalCwd,
  resolveTerminalEnv,
  resolveTerminalShell,
  resolveTerminalWindowsPtyInfo,
  spawnTerminalProcess,
  type TerminalPtyModule,
} from "./terminalProcess.js";

interface TerminalInstance {
  id: string;
  generation: number;
  scope?: RuntimeTerminalScope;
  executionScope?: RuntimeTerminalScope;
  cwd?: string;
  lease?: RuntimeTerminalEnvironmentLease;
  pty?: IPty;
  dataEmitter: Emitter<string>;
  exitEmitter: Emitter<number>;
  subscriptions: IDisposable[];
  admitted: ReturnType<typeof Promise.withResolvers<void>>;
  exit: ReturnType<typeof Promise.withResolvers<void>>;
  exited: boolean;
  stopRequested: boolean;
  releasing?: Promise<void>;
}

/** 本地生命周期方法不在 ITerminalService/RPC 中，只有 Host 组合根持有。 */
export interface TerminalServiceOwner extends ITerminalService {
  disposeAll(): void;
  disposeAllAndWait(): Promise<void>;
  stopWorkspaceAndWait(scope: RuntimeTerminalScope): Promise<void>;
  stopCheckoutAndWait(scope: RuntimeTerminalScope): Promise<void>;
}

/** 显式 RPC 白名单；TypeScript interface/cast 不会阻止 ProxyChannel 调用 owner 的内部方法。 */
export function createPublicTerminalService(owner: ITerminalService): ITerminalService {
  return {
    create: owner.create.bind(owner),
    write: owner.write.bind(owner),
    resize: owner.resize.bind(owner),
    dispose: owner.dispose.bind(owner),
    onDynamicData: owner.onDynamicData.bind(owner),
    onDynamicExit: owner.onDynamicExit.bind(owner),
  };
}

function scopeKey(scope: RuntimeTerminalScope): string {
  const path = resolve(scope.workspacePath);
  return JSON.stringify([
    scope.workspaceIdentity?.trim() || "",
    process.platform === "win32" ? path.toLowerCase() : path,
  ]);
}

export function createTerminalService(dependencies: {
  settingService: Pick<ISettingService, "get">;
  runtimeEnvironment?: RuntimeTerminalEnvironmentPort;
  /** Host 测试可替换真实 PTY；UI 无权提供 spawn 或环境覆盖。 */
  loadPty?: () => Promise<TerminalPtyModule>;
}): TerminalServiceOwner {
  const terminals = new Map<string, TerminalInstance>();
  const stoppedScopes = new Map<string, number>();
  const incarnation = randomUUID();
  const logger = createServiceLogger("terminal");
  let nextId = 0;
  let generation = 0;
  let closed = false;
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("terminal", () => ({
    open: [...terminals.values()].filter((terminal) => terminal.pty && !terminal.exited).length,
    retained: [...terminals.values()].filter((terminal) => terminal.lease).length,
  }));

  function matchesScope(terminal: TerminalInstance, key: string): boolean {
    return [terminal.scope, terminal.executionScope].some(
      (scope) => scope && scopeKey(scope) === key,
    );
  }
  function assertAdmission(terminal: TerminalInstance): void {
    if (
      closed ||
      [terminal.scope, terminal.executionScope].some(
        (scope) => scope && (stoppedScopes.get(scopeKey(scope)) ?? 0) > terminal.generation,
      )
    ) {
      throw new Error("cancelled: terminal owner stopped before PTY startup");
    }
  }
  function getTerminal(id: string): TerminalInstance {
    const terminal = terminals.get(id);
    if (!terminal?.pty || terminal.exited) throw new Error(`Terminal not found: ${id}`);
    return terminal;
  }
  function disposeEvents(terminal: TerminalInstance): void {
    for (const subscription of terminal.subscriptions) subscription.dispose();
    terminal.subscriptions = [];
    terminal.dataEmitter.dispose();
    terminal.exitEmitter.dispose();
  }

  async function releaseAfterExit(terminal: TerminalInstance): Promise<void> {
    if (!terminal.exited) throw new Error("process-unknown: terminal exit is not confirmed");
    if (terminal.releasing) return terminal.releasing;
    terminal.releasing = (async () => {
      await terminal.lease?.release();
      terminal.lease = undefined;
      // 迟到的旧代际回调只能结算自己，不删除同 key 的新 owner。
      if (terminals.get(terminal.id) === terminal) terminals.delete(terminal.id);
    })();
    try {
      await terminal.releasing;
    } catch (error) {
      // release 失败不能丢掉票据；保留在 owner 中，后续精确清理可重试。
      terminal.releasing = undefined;
      throw error;
    }
  }
  function onExit(terminal: TerminalInstance, exitCode: number): void {
    if (terminal.exited) return;
    terminal.exited = true;
    terminal.exit.resolve();
    terminal.exitEmitter.fire(exitCode);
    disposeEvents(terminal);
    void releaseAfterExit(terminal).catch(() => {
      logger.warn(undefined, "Terminal consumer release blocked", { terminalId: terminal.id });
    });
  }
  function requestStop(terminal: TerminalInstance): void {
    if (!terminal.pty || terminal.exited || terminal.stopRequested) return;
    terminal.stopRequested = true;
    try {
      terminal.pty.kill();
    } catch {
      if (terminal.exited) return;
      terminal.stopRequested = false;
      // kill 返回/抛错都不是退出证明；只有 onExit 才允许释放消费者。
      throw new Error("process-unknown: terminal stop is unconfirmed; consumer retained");
    }
  }
  async function stopAndWait(terminal: TerminalInstance): Promise<void> {
    await terminal.admitted.promise;
    requestStop(terminal);
    await terminal.exit.promise;
    await releaseAfterExit(terminal);
  }
  async function waitForAll(operations: Promise<void>[]): Promise<void> {
    const results = await Promise.allSettled(operations);
    const errors = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length)
      throw new AggregateError(errors, "release-blocked: terminal cleanup is incomplete");
  }

  async function create(params: TerminalCreateParams): ReturnType<ITerminalService["create"]> {
    if (closed) throw new Error("Terminal service is closed");
    const id = `${incarnation}:${nextId++}`;
    const workspacePath = params.workspacePath ?? params.cwd;
    const terminal: TerminalInstance = {
      id,
      generation,
      scope: workspacePath
        ? { workspacePath, workspaceIdentity: params.workspaceIdentity }
        : undefined,
      dataEmitter: new Emitter<string>(),
      exitEmitter: new Emitter<number>(),
      subscriptions: [],
      admitted: Promise.withResolvers<void>(),
      exit: Promise.withResolvers<void>(),
      exited: false,
      stopRequested: false,
    };
    terminals.set(id, terminal);
    try {
      if (
        !dependencies.runtimeEnvironment &&
        (params.environmentRef || params.executionBindingId)
      ) {
        throw new Error(
          "capability-unavailable: managed terminal environments are unavailable on this Host",
        );
      }
      if (terminal.scope && dependencies.runtimeEnvironment) {
        // 即使 UI 省略 envRef 也必须授权；Host 依据真实 binding 决定是否托管。
        terminal.lease =
          (await dependencies.runtimeEnvironment.acquire({
            ...terminal.scope,
            ...(params.cwd ? { cwd: params.cwd } : {}),
            ...(params.sessionId ? { sessionId: params.sessionId } : {}),
            ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
            ...(params.executionBindingId ? { executionBindingId: params.executionBindingId } : {}),
            ...(params.environmentRef ? { environmentRef: params.environmentRef } : {}),
            terminalId: id,
          })) ?? undefined;
        terminal.executionScope = terminal.lease?.executionScope;
        if (params.environmentRef && !terminal.lease) {
          throw new Error("stale-reference: managed terminal environment was not retained");
        }
      }
      assertAdmission(terminal);
      const env = terminal.lease
        ? applyTerminalEnvironment(resolveTerminalEnv(), terminal.lease.envOverlay)
        : resolveTerminalEnv();
      const cwd = await resolveTerminalCwd(
        terminal.lease?.cwd ??
          params.cwd ??
          terminal.executionScope?.workspacePath ??
          workspacePath,
        Boolean(terminal.lease),
      );
      terminal.cwd = cwd;
      assertAdmission(terminal);
      const settings = await dependencies.settingService.get().catch(() => ({
        terminalFontFamily: undefined,
        terminalInheritSystemProfile: true,
        integratedTerminalShell: undefined,
      }));
      assertAdmission(terminal);
      const shell = await resolveConfiguredTerminalShell(
        settings.integratedTerminalShell,
        await resolveTerminalShell(),
      );
      assertAdmission(terminal);
      const fontProfile = resolveTerminalFontProfile({ settings, env: process.env });
      const nodePty = await (dependencies.loadPty ?? loadNodePtyModule)();
      assertAdmission(terminal);
      await ensureNodePtySpawnHelperExecutable();
      assertAdmission(terminal);
      try {
        terminal.pty = spawnTerminalProcess({
          nodePty,
          shell,
          cols: params.cols,
          rows: params.rows,
          cwd,
          env,
        });
      } catch (error) {
        throw new Error(
          `Failed to start terminal with shell '${shell}' in '${cwd}': ${errorMessage(error)}`,
        );
      }
      terminal.subscriptions.push(
        terminal.pty.onExit(({ exitCode }) => onExit(terminal, exitCode)),
      );
      terminal.subscriptions.push(
        terminal.pty.onData((data) => {
          if (!terminal.exited) terminal.dataEmitter.fire(data);
        }),
      );
      return {
        id,
        shell,
        fontFamily: fontProfile.fontFamily,
        fontSize: fontProfile.fontSize,
        theme: fontProfile.theme,
        fontFamilySource: fontProfile.source,
        windowsPty: resolveTerminalWindowsPtyInfo(),
      };
    } catch (error) {
      if (!terminal.pty) {
        terminal.exited = true; // 未 spawn，没有需要等待的进程，允许释放已取得的票据。
        terminal.exit.resolve();
        disposeEvents(terminal);
        await releaseAfterExit(terminal);
      } else {
        requestStop(terminal);
      }
      throw error;
    } finally {
      terminal.admitted.resolve();
    }
  }

  const service: TerminalServiceOwner = {
    async create(params) {
      return create(terminalCreateParamsSchema.parse(params));
    },
    async write({ id, data }): Promise<void> {
      getTerminal(id).pty!.write(data);
    },
    async resize({ id, cols, rows }): Promise<void> {
      getTerminal(id).pty!.resize(cols, rows);
    },
    async dispose({ id }): Promise<void> {
      const terminal = terminals.get(id);
      if (terminal) await stopAndWait(terminal);
    },
    onDynamicData(id: string): Event<string> {
      return getTerminal(id).dataEmitter.event;
    },
    onDynamicExit(id: string): Event<number> {
      return getTerminal(id).exitEmitter.event;
    },
    disposeAll(): void {
      // 关闭 admission 必须先于等待；迟到的 acquire/settings/loader 不能再启动孤儿 PTY。
      closed = true;
      for (const terminal of terminals.values()) {
        try {
          requestStop(terminal);
        } catch {
          logger.warn(undefined, "Terminal stop is unconfirmed; consumer retained", {
            terminalId: terminal.id,
          });
        }
      }
    },
    async disposeAllAndWait(): Promise<void> {
      service.disposeAll();
      await waitForAll([...terminals.values()].map(stopAndWait));
      memoryDiagnostics.dispose();
    },
    async stopWorkspaceAndWait(scope): Promise<void> {
      const key = scopeKey(scope);
      stoppedScopes.set(key, ++generation);
      const existing = [...terminals.values()];
      await waitForAll(
        existing.map(async (terminal) => {
          // 授权返回前 executionScope 尚未知；等 admission 才能精确区分原项目与 checkout。
          await terminal.admitted.promise;
          if (matchesScope(terminal, key)) await stopAndWait(terminal);
        }),
      );
    },
    async stopCheckoutAndWait(scope): Promise<void> {
      stoppedScopes.set(scopeKey(scope), ++generation);
      await waitForAll(
        [...terminals.values()].map(async (terminal) => {
          // admission 完成后才能核对真实 checkout/cwd；不能仅按 UI 的工作区路径遗漏子目录 PTY。
          await terminal.admitted.promise;
          const candidates = [
            terminal.executionScope,
            terminal.scope,
            terminal.cwd
              ? {
                  workspacePath: terminal.cwd,
                  workspaceIdentity: terminal.scope?.workspaceIdentity,
                }
              : undefined,
          ];
          for (const target of candidates) {
            if (
              !target ||
              !(await isOwnedCheckoutScope(
                {
                  checkoutPath: scope.workspacePath,
                  workspaceIdentity: scope.workspaceIdentity,
                },
                target,
              ))
            )
              continue;
            stoppedScopes.set(scopeKey(target), generation);
            await stopAndWait(terminal);
            break;
          }
        }),
      );
    },
  };
  return service;
}
