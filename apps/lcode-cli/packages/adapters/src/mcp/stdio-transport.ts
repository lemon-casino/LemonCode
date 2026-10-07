import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/client/stdio";
import type { JSONRPCMessage } from "@modelcontextprotocol/client";
import type { ChildProcess } from "node:child_process";
import type { McpProjectEnvironment } from "@lcode/contracts";
import { terminateMcpStdioProcessTree } from "./process-tree.js";
import {
  attachProcessToWindowsJobObject,
  type WindowsJobObjectController,
} from "./windows-job-object.js";

type SdkStdioDispose = (this: StdioClientTransport) => Promise<void>;

const sdkDispose = Object.getOwnPropertyDescriptor(StdioClientTransport.prototype, "_dispose")
  ?.value as SdkStdioDispose | undefined;

type StdioRequestMetaProvider = () => Promise<Record<string, unknown> | undefined>;

interface StdioProcessExitInfo {
  exitCode: number | null;
  exitedAt: number;
  signal: NodeJS.Signals | null;
  startedAt: number;
}

type ProcessTreeStdioServerParameters = Omit<StdioServerParameters, "env"> & {
  /** undefined 是删除 SDK 默认继承变量的 spawn tombstone，不是字符串 "undefined"。 */
  env?: Record<string, string | undefined>;
  projectEnvironment?: McpProjectEnvironment;
  spawnSignal?: AbortSignal;
  /**
   * 官方 stdio MCP 的逐消息身份载荷提供器。它作为 spawn 参数的非执行字段保留，确保 SDK
   * 为 modern probe 克隆 sibling transport 时，`server/discover` 与正式 session 使用同一注入边界。
   */
  requestMetaProvider?: StdioRequestMetaProvider;
};

interface ProcessTreeStdioClientTransportOptions {
  windowsJobObjectFactory?: (pid: number) => Promise<WindowsJobObjectController | undefined>;
}

/**
 * SDK 2.0 会为 stdio 版本探测创建一次性兄弟进程，但其私有回收钩子只终止直接子进程。
 * launcher/watchdog 派生的后代会因此变成孤儿；在同一个钩子里先回收整棵进程树，再让
 * SDK 清理 pipe 和读取缓冲区。原型上必须直接拥有 `_dispose`，SDK 才会把该 transport
 * 识别为可安全克隆的探测 transport。
 */
export class ProcessTreeStdioClientTransport extends StdioClientTransport {
  private childProcess?: ChildProcess;
  private lastProcessExit?: StdioProcessExitInfo;
  private readonly requestMetaProvider?: StdioRequestMetaProvider;
  private readonly windowsJobObjectFactory: (
    pid: number,
  ) => Promise<WindowsJobObjectController | undefined>;
  private windowsJobObject?: WindowsJobObjectController;
  private readonly projectEnvironment?: McpProjectEnvironment;
  private readonly spawnSignal?: AbortSignal;
  private closing = false;
  private starting?: Promise<void>;
  private childClosed?: Promise<void>;
  private stopping?: Promise<void>;

  constructor(
    server: ProcessTreeStdioServerParameters,
    options: ProcessTreeStdioClientTransportOptions = {},
  ) {
    // SDK 的声明只允许 string；Node spawn 实际支持 undefined 以删除继承项。
    super(server as StdioServerParameters);
    this.projectEnvironment = server.projectEnvironment;
    this.spawnSignal = server.spawnSignal;
    this.requestMetaProvider = server.requestMetaProvider;
    this.windowsJobObjectFactory =
      options.windowsJobObjectFactory ?? attachProcessToWindowsJobObject;
  }

  async terminateWindowsJobObject(): Promise<void> {
    const windowsJobObject = this.windowsJobObject;
    this.windowsJobObject = undefined;
    if (!windowsJobObject) return;
    try {
      windowsJobObject.terminate();
    } catch {
      // 继续执行 close 与 taskkill 回退。
    } finally {
      try {
        windowsJobObject.close();
      } catch {
        // 句柄关闭失败不能阻断 SDK pipe 清理。
      }
    }
  }

  override async send(message: JSONRPCMessage): Promise<void> {
    const requestMeta = await this.requestMetaProvider?.();
    await super.send(mergeRequestMeta(message, requestMeta));
  }

  override start(): Promise<void> {
    const operation = this.startProcess();
    this.starting = operation;
    return operation;
  }

  private async startProcess(): Promise<void> {
    if (this.closing) throw new Error("MCP transport is closing");
    this.spawnSignal?.throwIfAborted();
    await this.projectEnvironment?.authorizeSpawn();
    this.spawnSignal?.throwIfAborted();
    if (this.closing) throw new Error("MCP transport closed before spawn");
    const startedAt = Date.now();
    await super.start();
    const child = (this as unknown as { _process?: ChildProcess })._process;
    if (!child) return;
    this.childProcess = child;
    this.childClosed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const recordExit = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      this.lastProcessExit ??= {
        exitCode,
        exitedAt: Date.now(),
        signal,
        startedAt,
      };
    };
    if (child.exitCode !== null || child.signalCode !== null) {
      recordExit(child.exitCode, child.signalCode);
      return;
    }
    child.once("exit", recordExit);

    // staging 曾把 Job Object 接管和退出观测各自合入成两个同名 start()，导致 CLI
    // 构建直接报 Duplicate function implementation；这里合并两个职责，保留 Windows
    // 进程树托管和跨平台退出记录。
    if (process.platform !== "win32" || this.pid == null) return;
    try {
      this.windowsJobObject = await this.windowsJobObjectFactory(this.pid);
    } catch {
      // 原生托管不可用时保留 taskkill 回退，不能让 MCP 建连因可选能力失败。
      this.windowsJobObject = undefined;
    }
  }

  get managedEnvironment(): boolean {
    return this.projectEnvironment !== undefined;
  }

  override close(): Promise<void> {
    if (!this.projectEnvironment) return super.close();
    this.stopping ??= this.closeManaged();
    return this.stopping;
  }

  private async closeManaged(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.starting ? [this.starting] : []);
    try {
      await this.terminateWindowsJobObject();
      if (this.childProcess?.pid && this.processAlive)
        await terminateMcpStdioProcessTree(this.childProcess.pid);
      await super.close();
      await this.waitForProcessExit();
    } catch (error) {
      this.projectEnvironment!.reportCloseFailure(error);
      throw error;
    }
  }

  async disposeProbe(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.starting ? [this.starting] : []);
    try {
      await this.terminateWindowsJobObject();
      if (this.pid != null) await terminateMcpStdioProcessTree(this.pid);
      if (sdkDispose) await sdkDispose.call(this);
      else await this.close();
      if (this.projectEnvironment) await this.waitForProcessExit();
    } catch (error) {
      // SDK 会吞掉 probe 回收错误；必须通知 app 保留 consumer，不能把 best effort 当退出证明。
      this.projectEnvironment?.reportCloseFailure(error);
      if (this.projectEnvironment) throw error;
      if (sdkDispose) await sdkDispose.call(this);
      else await this.close();
    }
  }

  private async waitForProcessExit(): Promise<void> {
    const child = this.childProcess;
    if (child && this.processAlive)
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    // SDK 的 close 有时间预算；只有原 pipe 的 close 证明才允许释放环境引用。
    await this.childClosed;
  }

  get processExit(): StdioProcessExitInfo | undefined {
    return this.lastProcessExit;
  }

  get processAlive(): boolean {
    return Boolean(
      this.childProcess &&
      this.childProcess.exitCode === null &&
      this.childProcess.signalCode === null,
    );
  }
}

function mergeRequestMeta(
  message: JSONRPCMessage,
  requestMeta: Record<string, unknown> | undefined,
): JSONRPCMessage {
  // JSON-RPC response 没有 method，不得给响应伪造 params。只修改 client 发出的请求与通知。
  if (!("method" in message) || !requestMeta || Object.keys(requestMeta).length === 0) {
    return message;
  }
  const params = isRecord(message.params) ? message.params : {};
  const existingMeta = isRecord(params._meta) ? params._meta : {};
  return {
    ...message,
    params: {
      ...params,
      // 宿主刚解析的官方身份载荷必须覆盖调用方残留值，避免旧凭证继续存活。
      _meta: { ...existingMeta, ...requestMeta },
    },
  } as JSONRPCMessage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

Object.defineProperty(ProcessTreeStdioClientTransport.prototype, "_dispose", {
  configurable: true,
  value(this: ProcessTreeStdioClientTransport): Promise<void> {
    return this.disposeProbe();
  },
});
