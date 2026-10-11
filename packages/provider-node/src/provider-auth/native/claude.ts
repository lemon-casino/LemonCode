import type { AuthDriver, AuthDriverContext, AuthGrant, AuthMethod, AuthModel } from "../driver.js";
import { authorizeClaude } from "./claude-auth.js";
import {
  claudeGrant,
  ClaudeProfile,
  spawnClaude,
  temporaryClaudeProfile,
  removeClaudeProfile,
} from "./claude-process.js";
import { identifyClaude } from "./claude-account.js";
import { ClaudeModels } from "./claude-models.js";
import { importChallenge } from "./imports.js";
import { followLocal, localAccount } from "./local.js";
import { defaultLocalIO, type LocalIO } from "./local-io.js";
import { ClaudeSession, type ClaudeSpawner } from "./claude-session.js";
import { runClaudeQuota } from "./claude-quota.js";
import {
  checkEndpoint,
  joinedSignal,
  list,
  record,
  requireGrant,
  text,
  type Fetcher,
} from "./common.js";

export class ClaudeAuthDriver implements AuthDriver {
  private readonly profile: ClaudeProfile;
  private readonly sessions = new Set<ClaudeSession>();
  private readonly lifetime = new AbortController();
  private readonly checks = new Set<Promise<void>>();
  private readonly operations = new Set<Promise<unknown>>();
  private connectionId?: string;
  private readonly catalog: ClaudeModels;
  constructor(
    private readonly spawn: ClaudeSpawner = spawnClaude,
    private readonly localIO: LocalIO = defaultLocalIO,
    modelFetcher: Fetcher = fetch,
  ) {
    this.profile = new ClaudeProfile(localIO);
    this.catalog = new ClaudeModels(modelFetcher);
  }
  async methods(): Promise<readonly AuthMethod[]> {
    return [
      {
        id: "browser",
        label: "Claude Code browser login (CLI required)",
        type: "oauth",
        kind: "browser",
      },
      {
        id: "local",
        label: "Use Claude Code's signed-in account",
        type: "oauth",
        kind: "local",
        description:
          "Uses this Host's current Claude Code profile. Claude Code keeps and refreshes its original credential; detect again after switching its account.",
      },
      {
        id: "files",
        label: "Import accounts from files",
        type: "oauth",
        kind: "import",
        description:
          "Imports Claude Code, CLIProxyAPI or Sub2API credentials. Claude Code refreshes them when used; their source application may need to sign in again.",
      },
      {
        id: "import",
        label: "Import Claude Code credential JSON",
        type: "oauth",
        kind: "credentials",
        fields: [{ key: "credentials", label: "Claude Code credential JSON", type: "password" }],
      },
    ];
  }
  async authorize(methodId: string, inputs: Record<string, string>, signal: AbortSignal) {
    signal = joinedSignal(signal, this.lifetime.signal);
    signal.throwIfAborted();
    if (methodId === "browser") return authorizeClaude(signal, this.spawn);
    if (methodId === "local")
      return {
        method: "auto" as const,
        complete: () => localAccount("claude", this.localIO, signal),
      };
    if (methodId === "files")
      return importChallenge("claude", inputs, signal, async (item, bounded) => {
        const grant = claudeGrant(item.credentials);
        const dir = await temporaryClaudeProfile(record(grant.claudeCredentials));
        try {
          const identified = await identifyClaude(grant, dir, this.spawn, bounded);
          if (!identified.identityKey) throw new Error("Claude account identity is missing");
          return identified;
        } finally {
          await removeClaudeProfile(dir);
        }
      });
    if (methodId !== "import") throw new Error("Unknown Claude authorization method");
    let raw: unknown;
    try {
      raw = JSON.parse(inputs.credentials ?? "");
    } catch {
      throw new Error("Invalid Claude credential JSON");
    }
    const grant = claudeGrant(raw);
    return {
      method: "auto" as const,
      complete: async () => {
        signal.throwIfAborted();
        const dir = await temporaryClaudeProfile(record(grant.claudeCredentials));
        try {
          const identified = await identifyClaude(grant, dir, this.spawn, signal);
          if (!identified.identityKey)
            throw new Error(
              "Claude account identity is missing; include its email or sign in with the browser",
            );
          return identified;
        } finally {
          await removeClaudeProfile(dir);
        }
      },
    };
  }
  models(context: AuthDriverContext): Promise<readonly AuthModel[]> {
    return this.track(this.discover(context));
  }
  async modelCatalog(context: AuthDriverContext) {
    await this.models(context);
    return this.catalog.read(context.signal);
  }
  private async discover(context: AuthDriverContext): Promise<readonly AuthModel[]> {
    this.bind(context);
    context = { ...context, signal: joinedSignal(context.signal, this.lifetime.signal) };
    const grant = await this.read(context);
    const dir = await this.profile.get(grant);
    const child = await this.spawner(grant)(["--version"], dir);
    const check = new Promise<void>((resolve, reject) => {
      let aborted = false;
      const abort = () => {
        aborted = true;
        child.kill();
      };
      const timer = setTimeout(abort, 15_000);
      context.signal?.addEventListener("abort", abort, { once: true });
      const clean = () => {
        clearTimeout(timer);
        context.signal?.removeEventListener("abort", abort);
      };
      child.stdout.resume();
      child.stderr.resume();
      child.once("error", () => {
        clean();
        reject(new Error("Claude Code CLI is required; install it or set LCODE_CLAUDE_BIN"));
      });
      child.once("close", (code) => {
        clean();
        if (aborted) reject(new Error("Claude CLI check cancelled"));
        else if (code === 0) resolve();
        else reject(new Error("Claude Code CLI dependency check failed"));
      });
      if (context.signal?.aborted) abort();
    });
    this.checks.add(check);
    try {
      await check;
    } finally {
      this.checks.delete(check);
    }
    return (await this.catalog.read(context.signal)).models;
  }
  fetch(request: Request, context: AuthDriverContext): Promise<Response> {
    return this.track(this.call(request, context));
  }
  private async call(request: Request, context: AuthDriverContext): Promise<Response> {
    this.bind(context);
    checkEndpoint(request, "https://api.anthropic.com/v1", ["/messages"]);
    if (request.method !== "POST") throw new Error("Claude bridge supports POST messages only");
    const body = record(await request.json());
    const signal = joinedSignal(request.signal, context.signal, this.lifetime.signal);
    context = { ...context, signal };
    signal.throwIfAborted();
    const grant = await this.read(context);
    for (const session of this.sessions) {
      if (session.closed) {
        await session.waitClosed();
        this.sessions.delete(session);
      } else if (session.accepts(body)) {
        const response = await session.continue(body, signal);
        await this.profile.sync(context);
        return response;
      }
    }
    if (
      list(record(list(body.messages).at(-1)).content).some(
        (block) =>
          record(block).type === "tool_result" &&
          text(record(block).tool_use_id).startsWith("toolu_lcode_"),
      )
    )
      throw new Error(
        "Claude tool continuation is no longer active or belongs to another conversation",
      );
    const dir = await this.profile.get(grant);
    const session = new ClaudeSession(body, dir, this.spawner(grant), () =>
      this.profile.sync(context),
    );
    this.sessions.add(session);
    try {
      const response = await session.start(signal);
      // 首个模型事件说明CLI已完成令牌检查；在HTTP返回前提交刷新，避免上一工具轮次signal结束后丢失刷新。
      await this.profile.sync(context);
      return response;
    } catch (error) {
      session.dispose();
      await session.waitClosed();
      this.sessions.delete(session);
      throw error;
    }
  }
  quota(context: AuthDriverContext): Promise<unknown> {
    return this.track(this.readQuota(context));
  }
  private async readQuota(context: AuthDriverContext): Promise<unknown> {
    this.bind(context);
    const signal = joinedSignal(context.signal, this.lifetime.signal);
    context = { ...context, signal };
    const grant = await this.read(context);
    const dir = await this.profile.get(grant);
    const quota = await runClaudeQuota(this.spawner(grant), dir, signal);
    await this.profile.sync(context);
    return { ...quota, ...(text(grant.plan) ? { plan: text(grant.plan) } : {}) };
  }
  private bind(context: AuthDriverContext): void {
    if (!context.connectionId) return;
    if (this.connectionId && this.connectionId !== context.connectionId)
      throw new Error("Claude driver cannot be shared between accounts");
    this.connectionId = context.connectionId;
  }
  private read(context: AuthDriverContext): Promise<AuthGrant> {
    return requireGrant(context).then((grant) => followLocal(grant, this.localIO, context.signal));
  }
  private spawner(grant: AuthGrant): ClaudeSpawner {
    const source = record(grant.localSource);
    return source.channel === "claude" && !source.custom
      ? (args, dir, additions) =>
          this.spawn(args, dir, { CLAUDE_CONFIG_DIR: undefined, ...additions })
      : this.spawn;
  }
  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation);
    void operation.finally(() => this.operations.delete(operation)).catch(() => {});
    return operation;
  }
  async dispose(): Promise<void> {
    this.lifetime.abort();
    for (const session of this.sessions) session.dispose();
    await Promise.allSettled(this.operations);
    // Windows仍运行的CLI会锁住cwd；先等待真实close事件，再删除本账号临时profile。
    await Promise.allSettled([
      ...this.checks,
      ...Array.from(this.sessions, (session) => session.waitClosed()),
    ]);
    this.sessions.clear();
    await this.profile.dispose();
  }
}
