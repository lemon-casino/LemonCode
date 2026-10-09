import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { applyBashSourcesToExecutionRequest } from "./bash-startup-script.js";
import { createBashResourceTelemetry } from "./bash-resource-telemetry.js";
import { createCwdCapturePlan } from "./cwd-capture.js";
import {
  applyResolvedShellCommand,
  buildExecutionEnv,
  resolveExecutionCommand,
  setResolvedShellLoginMode,
} from "./execution-command.js";
import { NodeExecutionAdapterResults } from "./node-execution-adapter-results.js";
import { createExecutionOutputStreamDecoder } from "./outputEncoding.js";
import type { OutputCollector } from "./output-collector.js";
import {
  BASH_SIGTERM_TO_SIGKILL_MS,
  signalPosixProcessTree,
  terminateGenericPosixProcessGroup,
} from "./process-tree.js";
import {
  revalidateShellInitSnapshotForExecution,
  supportsShellInitSnapshot,
} from "./shell-init-snapshot.js";
import {
  IO_DRAIN_TIMEOUT_MS,
  resolveDefaultOutputRootDir,
  sanitizePathSegment,
  waitForPromise,
} from "./execution-utils.js";
import type {
  ExitState,
  InternalExecutionRunOptions,
  PreparedChildSpawn,
} from "./execution-adapter-types.js";
import type { ExecutionRequest, ExecutionRunOptions } from "@lcode/contracts";

export class NodeExecutionAdapterProcess extends NodeExecutionAdapterResults {
  protected spawnPreparedChild(prepared: PreparedChildSpawn): ChildProcess {
    return spawn(prepared.command.file, prepared.command.args, prepared.spawnOptions);
  }

  protected trackBashResources(
    child: ChildProcess,
    isBash: boolean,
    stopState: () => { timedOut: boolean; killed: boolean },
  ): (state: ExitState) => void {
    if (!isBash || !this.options.onToolExecResource) return () => {};
    const telemetry = createBashResourceTelemetry({
      platform: this.platform,
      processGroupId: child.pid,
      onComplete: this.options.onToolExecResource,
    });
    return (state) => {
      const stop = stopState();
      telemetry.finish(
        stop.timedOut
          ? "timeout"
          : stop.killed || state.signal
            ? "killed"
            : state.error
              ? "error"
              : "completed",
      );
    };
  }

  protected async prepareChildSpawn(request: ExecutionRequest): Promise<PreparedChildSpawn> {
    const env = buildExecutionEnv(request.env, {
      network: this.options.network,
      platform: this.platform,
      processEnv: this.processEnv,
    });
    const resolvedCommand = resolveExecutionCommand(request.command, {
      cwd: request.cwd,
      env,
      platform: this.platform,
    });
    const rootDir =
      this.options.outputRootDir ?? resolveDefaultOutputRootDir(this.options.processEnv);
    const sessionId = sanitizePathSegment(String(request.trace?.sessionId ?? "unknown-session"));
    const snapshotEnv = resolvedCommand.envOverlay
      ? { ...env, ...resolvedCommand.envOverlay }
      : env;
    const shellInitSnapshot =
      request.command.mode === "shell" &&
      request.command.shellProfile === "posix-bash" &&
      resolvedCommand.shell === false &&
      supportsShellInitSnapshot(resolvedCommand.cwdDialect)
        ? await revalidateShellInitSnapshotForExecution(
            await this.shellInitSnapshots.getOrCreate({
              env: snapshotEnv,
              rootDir,
              shellDialect: resolvedCommand.cwdDialect,
              shellPath: resolvedCommand.file,
            }),
          )
        : undefined;
    const useLoginShell = shellInitSnapshot ? false : true;
    const resolvedShell = setResolvedShellLoginMode(resolvedCommand, useLoginShell);
    const requestWithSources = applyBashSourcesToExecutionRequest(request, {
      leadingSources: shellInitSnapshot
        ? [
            {
              optional: true,
              path: shellInitSnapshot.path,
              shellPath: shellInitSnapshot.shellPath,
            },
          ]
        : [],
      rootDir,
      sessionId,
      shellDialect: resolvedCommand.cwdDialect,
    });
    const capturePlan = createCwdCapturePlan(requestWithSources, {
      dialect: resolvedCommand.cwdDialect,
      platform: this.platform,
    });
    const command =
      capturePlan.command === requestWithSources.command
        ? requestWithSources.command.mode === "shell"
          ? applyResolvedShellCommand(resolvedShell, requestWithSources.command.command)
          : resolvedShell
        : resolveExecutionCommand(capturePlan.command, {
            cwd: request.cwd,
            env,
            platform: this.platform,
            resolvedShell,
          });
    const spawnEnv = command.envOverlay ? { ...env, ...command.envOverlay } : env;
    const baseOptions = {
      cwd: request.cwd,
      detached: this.platform !== "win32",
      env: spawnEnv,
      shell: command.shell,
      stdio: [
        request.stdin === undefined ? "ignore" : "pipe",
        "pipe",
        "pipe",
      ] satisfies StdioOptions,
      windowsHide: true,
    };

    return {
      command,
      cwdDialect: command.cwdDialect,
      cwdFilePath: capturePlan.cwdFilePath,
      spawnOptions: baseOptions,
    };
  }

  protected terminateProcessTree(
    child: ChildProcess,
    useBashProcessTreeStop: boolean,
  ): Promise<void> | void {
    if (!child.pid) {
      child.kill("SIGTERM");
      return;
    }

    if (this.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      const completion = new Promise<void>((resolve) => {
        killer.once("error", () => {
          child.kill("SIGKILL");
          resolve();
        });
        killer.once("close", () => resolve());
      });
      if (useBashProcessTreeStop) {
        // 直写后不再等待 pipe EOF，shutdown 必须显式等待 taskkill 收尾，避免提前释放资源。
        this.pendingBashProcessTreeKills.set(completion, killer);
        void completion.finally(() => this.pendingBashProcessTreeKills.delete(completion));
        return completion;
      }
      return;
    }

    if (!useBashProcessTreeStop) {
      // PPID 后代枚举只修复 Bash job-control 的跨 PGID 清理；通用 hook、
      // shell 和 argv execution 必须保留既有进程组边界，避免修复能力扩散到其它调用方。
      terminateGenericPosixProcessGroup(child);
      return;
    }

    const rootPid = child.pid;
    // Bash job control、pipeline、xargs 和 PTY 可以把 worker 放入不同 PGID。
    // 两阶段清理各自快照当时的 PPID 后代，不跨阶段记忆进程身份。
    void signalPosixProcessTree(rootPid, "SIGTERM");
    let timer!: NodeJS.Timeout;
    const escalation = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        try {
          process.kill(-rootPid, "SIGKILL");
        } catch {
          // 直接的 force group kill 只做 best effort，随后仍会执行完整杀树。
        }
        // shutdown 等待实际查表与信号发送，不能在异步杀树刚启动时就释放清理所有权。
        void signalPosixProcessTree(rootPid, "SIGKILL").then(resolve);
      }, BASH_SIGTERM_TO_SIGKILL_MS);
      // 当前 execution 要等待杀树完成；清理计时器必须保活，不能让等待中的 Promise 悬空。
    });
    this.pendingBashProcessTreeKills.set(escalation, timer);
    void escalation.finally(() => {
      this.pendingBashProcessTreeKills.delete(escalation);
    });
    return escalation;
  }

  protected destroyChildOutputStreams(child: ChildProcess): void {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }

  protected attachPipedOutput(
    child: ChildProcess,
    stdout: OutputCollector,
    stderr: OutputCollector,
    encoding: string | null,
    options: ExecutionRunOptions,
  ): void {
    for (const [name, collector] of [
      ["stdout", stdout],
      ["stderr", stderr],
    ] as const) {
      const stream = child[name];
      const decoder = createExecutionOutputStreamDecoder(encoding);
      stream?.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        collector.append(buffer, stream);
        this.emit(options, {
          type: name,
          chunk: buffer,
          text: decoder.write(buffer),
          timestamp: new Date(),
        });
      });
    }
  }

  protected watchPipedProgress(
    child: ChildProcess,
    stdout: OutputCollector,
    stderr: OutputCollector,
    options: ExecutionRunOptions,
    startedAt: Date,
    shouldReport: () => boolean,
  ): NodeJS.Timeout | undefined {
    if (!options.onEvent) return undefined;
    const timer = setInterval(() => {
      if (!shouldReport()) return;
      const elapsedMs = Date.now() - startedAt.getTime();
      if (elapsedMs < this.progressThresholdMs) return;
      this.emit(options, {
        type: "progress",
        elapsedMs,
        pid: child.pid,
        stdoutBytes: stdout.bytes,
        stderrBytes: stderr.bytes,
        stdoutTail: stdout.tailText(),
        stderrTail: stderr.tailText(),
        timestamp: new Date(),
      });
    }, this.progressIntervalMs);
    timer.unref?.();
    return timer;
  }

  protected writeChildInput(
    child: ChildProcess,
    input: ExecutionRequest["stdin"],
  ): () => Error | undefined {
    let failure: Error | undefined;
    if (input !== undefined && child.stdin) {
      const capture = (error: Error) => {
        failure ??= error;
      };
      // Hook 可以提前关闭 stdin，异步 EPIPE 必须有监听，不能让 Agent 崩溃。
      child.stdin.on("error", capture);
      try {
        child.stdin.end(input);
      } catch (error) {
        capture(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return () => failure;
  }

  protected async drainChildOutput(
    child: ChildProcess,
    closed: Promise<void>,
    options: InternalExecutionRunOptions,
    terminationRequested: boolean,
  ): Promise<void> {
    if (await waitForPromise(closed, IO_DRAIN_TIMEOUT_MS)) return;
    // 通用 argv/Hook 保留 pipe EOF 所有权；Bash 直写文件不会进入此路径。
    if (options.shouldRetainExecutionAfterRootExit?.() === true) {
      await closed;
      return;
    }
    if (!terminationRequested) this.terminateProcessTree(child, false);
    if (!(await waitForPromise(closed, IO_DRAIN_TIMEOUT_MS))) this.destroyChildOutputStreams(child);
  }
}
