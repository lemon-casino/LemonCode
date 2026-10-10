import { createCliProviderRefreshReporter } from "./provider-runtime-env.js";
import { createPhysicalRequestAccounting, goalAcceptanceSchema } from "@lcode/contracts";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import {
  listCustomCommandsForPrompt,
  routesToPromptCommandCenter,
  runPromptCommandCenterCommand,
} from "./prompt-command-routing.js";
import {
  resolveHeadlessWorkspaceHookTrustDiagnostic,
  wantsEventStream,
  writePromptResult,
} from "./prompt-output.js";
import { extname } from "node:path";
import type { PresentationSurface } from "@lcode/core";
import type { RunContext, GlobalOptions } from "@lcode/shared-types";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import {
  buildManualSkillPrompt,
  formatSlashCommandHelp,
  parseSlashCommand,
} from "./command-center.js";
import { loadCliDotenv } from "./env.js";
import { createCliHeadlessBrowserRuntime } from "./headless-browser.js";
import {
  createHeadlessPermissionBroker,
  createHeadlessSessionObserver,
  readHeadlessRuntimeFacts,
  waitForHeadlessWorkflowSettle,
} from "./headless-workflow.js";
import { runLoginCommand, runLogoutCommand } from "./login-command.js";
import { resolveResumeSession } from "./resume.js";
import { readRuntimeEventSubscriber } from "./runtime-event-subscriber.js";
import {
  DEFAULT_CLI_CLEANUP_TIMEOUT_MS,
  registerCliShutdownHandlers,
  runCliCleanupWithTimeout,
} from "./shutdown.js";
import { runSkillsCommand } from "./skills-command.js";
import type {
  CliPermissionMode,
  CliResumeRequest,
  ModeCapableApp,
  RunDependencies,
} from "./cli-types.js";

const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi"]);
const EMPTY_PROMPT_ERROR = "--prompt requires non-empty text.";
const MEMORY_BENCH_DISABLED_ERROR =
  "--memory-bench requires Project Memory to be enabled (features.memory=true and memory.use=true).";
export const runPrompt = async (
  ctx: RunContext,
  prompt: string,
  attachmentPaths: string[],
  options: GlobalOptions,
  deps: RunDependencies,
  version: string,
  mode?: CliPermissionMode,
  resumeRequest: CliResumeRequest = { continueSession: false },
  toolDisallowlist?: readonly string[],
  forceMcs = false,
  presentationSurface: PresentationSurface = "terminal",
): Promise<number> => {
  if (prompt.trim().length === 0) {
    ctx.stderr.write(`${EMPTY_PROMPT_ERROR}\n`);
    return 1;
  }

  const slashCommand = parseSlashCommand(prompt);
  if (slashCommand?.type === "known" && slashCommand.name === "help") {
    ctx.stdout.write(
      `${formatSlashCommandHelp(slashCommand.args, await listCustomCommandsForPrompt(deps))}\n`,
    );
    return 0;
  }
  if (slashCommand?.type === "known" && slashCommand.name === "skill" && !slashCommand.skillName) {
    return await runSkillsCommand(ctx, options, deps, []);
  }
  if (slashCommand?.type === "known" && slashCommand.name === "login") {
    if (slashCommand.args.length > 0) {
      ctx.stderr.write("Usage: /login\n");
      return 1;
    }
    return await runLoginCommand(ctx, options, deps, false);
  }
  if (slashCommand?.type === "known" && slashCommand.name === "logout") {
    if (slashCommand.args.length > 0) {
      ctx.stderr.write("Usage: /logout\n");
      return 1;
    }
    return await runLogoutCommand(ctx, options, deps);
  }

  const runtimePrompt =
    slashCommand?.type === "known" && slashCommand.name === "skill"
      ? buildManualSkillPrompt(slashCommand.skillName, slashCommand.task)
      : prompt;

  let traceId: string | undefined;
  let app:
    | Awaited<ReturnType<Awaited<ReturnType<typeof loadBootstrapModule>>["createLCodeApp"]>>
    | undefined;
  let closePromise: Promise<void> | undefined;
  let browserRuntime: ReturnType<typeof createCliHeadlessBrowserRuntime>;
  let shutdownTelemetry: (() => Promise<void>) | undefined;
  // 常驻事件订阅的摘除句柄。声明在这里而不是 try 内，是为了让 finally 也能收口——
  // 任何早退（command-center 路径、抛错）都不能留下一个还在写 stdout 的 sink。
  let detachEvents: (() => void) | undefined;
  const stopObservingEvents = () => {
    detachEvents?.();
    detachEvents = undefined;
  };
  let providerRegistryRuntime: Awaited<
    ReturnType<NonNullable<RunDependencies["startProcessProviderRegistryRuntime"]>>
  >;
  const abortController = new AbortController();
  let requestAccounting: ReturnType<typeof createPhysicalRequestAccounting> | undefined;
  const cleanupTimeoutMs = Math.max(
    1,
    Math.trunc(deps.shutdownCleanupTimeoutMs ?? DEFAULT_CLI_CLEANUP_TIMEOUT_MS),
  );
  const closeApp = async (): Promise<void> => {
    const targetApp = app;
    closePromise ??= (async () => {
      await runCliCleanupWithTimeout(async () => targetApp?.close?.(), cleanupTimeoutMs);
      // Browser process 由 CLI adapter 持有；App close 悬空或失败也必须继续回收 Chromium。
      await runCliCleanupWithTimeout(async () => browserRuntime?.close(), cleanupTimeoutMs);
      // Bug 根因：App.close 只结束 Session 并 flush，共享 OTLP Owner 过去没有进程级终态。
      // 单次 prompt 是最外层生命周期，必须与 prepare 对称 shutdown。
      await runCliCleanupWithTimeout(async () => shutdownTelemetry?.(), cleanupTimeoutMs);
      providerRegistryRuntime?.dispose();
    })();
    await closePromise;
  };
  const unregisterShutdownHandlers = registerCliShutdownHandlers({
    abort: (signal) => abortController.abort(new Error(`CLI received ${signal}`)),
    cleanup: closeApp,
    cleanupTimeoutMs: deps.shutdownCleanupTimeoutMs,
    exitProcess: deps.exitProcess,
    process: deps.shutdownProcess,
  });
  try {
    if (options.benchmarkLimits) {
      const limits = JSON.parse(options.benchmarkLimits) as {
        maxRequests: number;
        maxReservedTokens: number;
      };
      requestAccounting = createPhysicalRequestAccounting(limits, (reason) =>
        abortController.abort(new Error(reason)),
      );
    }
    const env = deps.env ?? process.env;
    const workingDirectory = (deps.cwd ?? process.cwd)();
    const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({
      cwd: workingDirectory,
      env,
    });

    if (dotenvResult.error) {
      throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
        cause: dotenvResult.error,
      });
    }

    const sessionId = await resolveResumeSession(resumeRequest, workingDirectory, env, deps);
    const bootstrapModule = deps.createLCodeApp ? undefined : await loadBootstrapModule();
    const createApp = deps.createLCodeApp ?? bootstrapModule?.createLCodeApp;
    if (!createApp) throw new Error("LCode app factory is unavailable.");
    const streamsEvents = wantsEventStream(options);
    let mapSessionEvent: NonNullable<RunDependencies["mapSessionEvent"]> | undefined;
    if (streamsEvents) {
      mapSessionEvent = deps.mapSessionEvent ?? bootstrapModule?.mapSessionEvent;
      if (!mapSessionEvent) {
        throw new Error("Event streaming is unavailable: the bootstrap module did not load.");
      }
    }
    const observer = createHeadlessSessionObserver({
      ...(mapSessionEvent ? { mapSessionEvent } : {}),
      options,
      stderr: ctx.stderr,
      stdout: ctx.stdout,
    });
    const prepareTelemetry =
      deps.prepareLCodeTelemetryEnv ?? bootstrapModule?.prepareLCodeTelemetryEnv;
    if (prepareTelemetry) {
      shutdownTelemetry = deps.shutdownLCodeTelemetry ?? bootstrapModule?.shutdownLCodeTelemetry;
    }
    const appEnv = prepareTelemetry
      ? await prepareTelemetry(env, {
          cliVersion: version,
          productVersion: env.LCODE_APP_VERSION,
        })
      : env;
    const startProviderRegistryRuntime =
      deps.startProcessProviderRegistryRuntime ??
      bootstrapModule?.startProcessProviderRegistryRuntime;
    if (!startProviderRegistryRuntime) {
      throw new Error("Provider Registry runtime is unavailable.");
    }
    providerRegistryRuntime = await startProviderRegistryRuntime(
      appEnv,
      deps.skipUserConfig
        ? {}
        : {
            standalone: {
              ...createCliProviderRefreshReporter(ctx.stderr),
              ...(deps.userConfigPath ? { legacyCliUserConfigFilePath: deps.userConfigPath } : {}),
            },
          },
    );
    browserRuntime = createCliHeadlessBrowserRuntime(options, deps);
    app = await createApp({
      ...(requestAccounting ? { physicalRequestAccounting: requestAccounting } : {}),
      browserControlPort: browserRuntime?.browserControlPort,
      env: appEnv,
      // headless 没有交互审批面，core 因此退到 deny broker，于是 CreateWorkflow 的
      // alwaysAsk gate 在 -p 下**必然被拒**（"No permission client configured"）。
      // 这个最小 broker 只按工具名放行 CreateWorkflow，其余工具委托回同一个 deny
      // broker，语义逐字不变。详见 headless-workflow.ts 的注释。
      permissionBroker: createHeadlessPermissionBroker(),
      providerRegistry: providerRegistryRuntime.runtime.registryService,
      configuredDefaultModelSelection: providerRegistryRuntime.configuredDefaultModelSelection,
      ...(providerRegistryRuntime.providerRuntimeHeadersPort
        ? {
            providerRuntimeHeadersPort: providerRegistryRuntime.providerRuntimeHeadersPort,
          }
        : {}),
      resume: sessionId !== undefined,
      runtimeConfig: {
        ...(mode ? { mode } : {}),
        ...(toolDisallowlist ? { toolDisallowlist } : {}),
        ...(forceMcs ? { midConversationSystem: { mode: "force" as const } } : {}),
        memory: { extractionEnabled: options.memoryBench === true },
        modelStreaming: "on",
        presentationSurface,
        workingDirectory,
      },
      sessionId,
      uiDetectedLocale: options.detectedLocale,
      uiLocale: options.locale,
      version,
    });
    // 异步身份导入期间可能已收到退出信号；既有的 cleanup 尚拿不到这个 App。
    // 单独释放迟到实例，禁止继续提交，也不重启已结束的进程级清理。
    if (abortController.signal.aborted) {
      const lateApp = app;
      app = undefined;
      await runCliCleanupWithTimeout(async () => lateApp.close?.(), cleanupTimeoutMs);
      throw abortController.signal.reason;
    }
    traceId = app.traceId;
    if (options.memoryBench && !app.runtime.isProjectMemoryEnabled()) {
      throw new Error(MEMORY_BENCH_DISABLED_ERROR);
    }

    // 按**可解析性**分流，不按拼写。
    //
    // 自定义命令解析出来一律是 `type === "unknown"`，过去因此全部早退进
    // command-center；那条路径自己 submit 完就 return，于是只挂在下面普通 prompt 路径上
    // 的三件机制全被跳过——dwf 结算等待、常驻事件订阅的单一写者、`response` 取最后一个
    // 回合。结果是 `lcode -p "/workflow ..."` 在第一个回合后就退出，把在飞的 run 孤儿化
    // 成 Interrupted。能解析成真实自定义命令的必须落到普通 prompt 路径，提交**原文**即可：
    // facade 的 customCommandPromptResolver 会在服务端展开（$ARGUMENTS、skills: 前言、`!`）。
    // 解析不出来的名字继续留在 command-center，拿它的 "Unknown command" 文案；保留名
    // （`/compress` 是唯一一个 CLI 解析成 unknown 而 facade 又拒绝展开的）同样留在那边，
    // 判据与 facade 的 gate 共用一个来源，见 isResolvableCustomCommand。
    // `/expert`、`/goal` 走不到 submitPrompt，路由逐字不变。
    if (slashCommand && (await routesToPromptCommandCenter(slashCommand, deps))) {
      return await runPromptCommandCenterCommand(
        ctx,
        options,
        app as ModeCapableApp,
        prompt,
        mode,
        traceId,
        abortController.signal,
        deps,
      );
    }

    // 事件的**单一写者**。常驻订阅跨回合存活，所以完成通知驱动的回合（core 自驱，
    // `runtime-command-queue.ts:336`）的事件也在内；per-turn `onEvent` 则在 submitPrompt
    // 的 finally 里就被摘掉（`input-facade.ts:361-372`），看不到那些回合。
    //
    // 两者**绝不同时装**：同一条事件被两个 sink 各写一次就是一行重复的 NDJSON。
    // 这里用「二选一」而不是「双装 + 按 id 去重」，因为前者让恰好一次成为结构性事实，
    // 不依赖任何 sink 的调用顺序。
    //
    // 挂载点刻意在 command-center 分支**之后**：`/expert`、`/goal` 走不到 submitPrompt，
    // 过去也从不透出事件行，在这里挂就会给那条路径凭空加出 NDJSON 行。
    const subscribeEvents = readRuntimeEventSubscriber(app.runtime);
    detachEvents = subscribeEvents?.({ onSessionEvent: observer.observe });
    const runtimeFacts = readHeadlessRuntimeFacts(app.runtime);
    if (options.goalAcceptancePath) {
      const acceptanceFile = await open(resolve(workingDirectory, options.goalAcceptancePath), "r");
      let acceptance;
      try {
        if ((await acceptanceFile.stat()).size > 65536)
          throw new Error("Goal acceptance exceeds 64 KiB.");
        const bytes = Buffer.alloc(65537);
        const { bytesRead } = await acceptanceFile.read(bytes, 0, bytes.length, 0);
        if (bytesRead > 65536) throw new Error("Goal acceptance exceeds 64 KiB.");
        acceptance = goalAcceptanceSchema.parse(
          JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")),
        );
      } finally {
        await acceptanceFile.close();
      }
      await app.setTarget({ objective: runtimePrompt, status: "active", acceptance });
    } else if (options.promptGoal) {
      await app.setTarget({ objective: runtimePrompt, status: "active" });
    }
    const result = await app.submitPrompt(
      attachmentPaths.length > 0
        ? {
            text: runtimePrompt,
            attachments: attachmentPaths.map((path) => ({
              type: inferAttachmentTypeFromPath(path),
              path,
            })),
          }
        : runtimePrompt,
      {
        abortSignal: abortController.signal,
        // 常驻订阅装上了就绝不再装 per-turn sink（见上面的单一写者注释）。
        ...(detachEvents ? {} : { onEvent: observer.observe }),
      },
    );
    // 同步紧接着 submitPrompt：这一刻到第一个 await 之间没有任何事件能插队，所以
    // 「run 在回合内就结算了、通知回合已经在跑」这种情况也不会漏掉它的第一条事件。
    observer.beginWaitPhase(result.turnId ? String(result.turnId) : undefined);
    traceId = result.traceId ?? traceId;
    // 在飞的 workflow run 不能被进程退出孤儿化。窄触发（观察到过 dwf 活动）+ 宽排水
    // （runtime 的两个 busy 事实）——论证见 waitForHeadlessWorkflowSettle 的注释。
    if (observer.hasWorkflowActivity() && runtimeFacts) {
      await waitForHeadlessWorkflowSettle({
        runtime: runtimeFacts,
        signal: abortController.signal,
      });
    }
    // bench 的正常等待必须先于 close；close 会取消 Extraction，且有独立的清理时限。
    if (options.memoryBench) {
      await app.runtime.drainMemoryExtractions(null);
      abortController.signal.throwIfAborted();
    }
    // 结果行之后绝不能再冒出事件行——stream-json 的 result 是流的终止符。
    stopObservingEvents();
    // `response` 取**最后**一个回合的文本：工作流结算后的那次总结才是答案。
    // 未进入等待时数组只有一项，于是 response ≡ result.response，行为逐字节不变。
    const turnResponses = [result.response, ...observer.waitPhaseTurnResponses()].filter(
      (text) => text.trim().length > 0,
    );
    const response = turnResponses.at(-1) ?? result.response;
    // 单回合不附加 turnResponses；在信任诊断 await 前保留原有判断时机。
    const multiTurn = turnResponses.length > 1;
    const hookTrustDiagnostic = await resolveHeadlessWorkspaceHookTrustDiagnostic({
      bootstrapModule,
      deps,
      events: result.events,
      workingDirectory,
    });

    const benchmarkGoal =
      requestAccounting && (options.promptGoal || options.goalAcceptancePath)
        ? await app.readTarget()
        : null;
    if (requestAccounting) {
      // 统计终态须覆盖 sidecar 收尾；冻结后禁止迟到任务再发物理请求。
      await closeApp();
      requestAccounting.seal();
    }

    return writePromptResult({
      ctx,
      options,
      app,
      streamsEvents,
      multiTurn,
      traceId,
      result,
      response,
      turnResponses,
      hookTrustDiagnostic,
      ...(requestAccounting
        ? {
            physicalRequests: requestAccounting.snapshot(),
            benchmarkTreatment: {
              goal: benchmarkGoal
                ? {
                    policy:
                      benchmarkGoal.acceptance?.policy === "strict"
                        ? ("strict" as const)
                        : ("legacy" as const),
                    status: benchmarkGoal.status,
                    requirementCount: benchmarkGoal.acceptance?.requirements.length ?? 0,
                  }
                : null,
            },
          }
        : {}),
    });
  } catch (error) {
    if (requestAccounting && wantsEventStream(options)) {
      stopObservingEvents();
      await closeApp();
      requestAccounting.seal();
      ctx.stdout.write(
        `${JSON.stringify({ type: "result", status: "error", response: "", physicalRequests: requestAccounting.snapshot() })}\n`,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Error: ${message}${traceId ? ` (traceId: ${traceId})` : ""}\n`);
    if (options.verbose) {
      if (error instanceof Error && error.cause) {
        ctx.stderr.write(`Cause: ${error.cause}\n`);
      }
      if (error instanceof Error && error.stack) {
        ctx.stderr.write(`${error.stack}\n`);
      }
    }
    return 1;
  } finally {
    stopObservingEvents();
    unregisterShutdownHandlers();
    await closeApp();
  }
};

function inferAttachmentTypeFromPath(path: string): "file" | "image" | "video" | "pdf" {
  const extension = extname(path).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (extension === ".pdf") return "pdf";
  return "file";
}
