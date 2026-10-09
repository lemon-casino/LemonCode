import type { SpawnOptions } from "node:child_process";
import type { LCodeToolExecResource } from "@lcode/shared";
import type { NetworkEgressEnvPolicy } from "../network/subprocess-env.js";
import type { ResolvedSpawnCommand } from "./execution-command.js";
import type { BashProcessOwner } from "./bash-process-owner.js";
import type {
  BackgroundExecutionSnapshot,
  BackgroundExecutionStartResult,
  ExecutionResult,
  ExecutionRunOptions,
  ExecutionShellDialect,
} from "@lcode/contracts";

export interface ExitState {
  code?: number;
  signal?: string;
  error?: Error;
}

export interface BackgroundTaskRecord extends BackgroundExecutionSnapshot {
  sessionId?: string;
  isBash: boolean;
  legacyOutputEncoding: string | null;
  completion: Promise<BackgroundExecutionSnapshot>;
  controller: AbortController;
  externalAbort?: () => void;
  resolveCompletion: (snapshot: BackgroundExecutionSnapshot) => void;
}

export interface ExecutionOutputPaths {
  outputPath?: string;
  stderrPersistedOutputPath?: string;
  stdoutPersistedOutputPath?: string;
}

export interface InternalExecutionRunOptions extends ExecutionRunOptions {
  onOutputEncodingResolved?: (encoding: string | null) => void;
  /** Bash 移交时停止前台预览并重启文件 watchdog；不复制进程或输出。 */
  bashLifecycle?: {
    isBackgrounded: () => boolean;
    onBackgrounded?: () => void;
    onExit?: () => void;
  };
  onPersistedLimit?: () => void;
  sharePersistedOutputLimitAcrossStreams?: boolean;
  shouldStopOnPersistedLimit?: () => boolean;
  shouldRetainExecutionAfterRootExit?: () => boolean;
}

export type BashBackgroundLifecycleMode = "explicit" | "auto_on_timeout";

export type BashBackgroundLifecycleResult =
  | {
      kind: "foreground";
      result: ExecutionResult;
    }
  | {
      kind: "backgrounded";
      task: BackgroundExecutionStartResult;
    };

export interface PreparedChildSpawn {
  command: ResolvedSpawnCommand;
  cwdDialect: ExecutionShellDialect;
  cwdFilePath?: string;
  spawnOptions: SpawnOptions;
}

export interface ActiveExecutionRecord {
  completion: Promise<void>;
  resolveCompletion: () => void;
  stop: (reason: StopReason) => void;
}

export interface NodeExecutionAdapterOptions {
  /** OS 进程所有权 adapter；测试可注入退出确认和失败重试，不改变工具协议。 */
  bashProcessOwnerFactory?: (platform: NodeJS.Platform) => Promise<BashProcessOwner>;
  onToolExecResource?: (sample: LCodeToolExecResource) => void;
  outputRootDir?: string;
  maxPersistedOutputBytes?: number;
  network?: NetworkEgressEnvPolicy;
  platform?: NodeJS.Platform;
  processEnv?: NodeJS.ProcessEnv;
  progressIntervalMs?: number;
  progressTailBytes?: number;
  progressThresholdMs?: number;
}

export type OutputPersistenceMode = "none" | "on_truncate" | "always";

export type StopReason = "timeout" | "cancelled" | "output_limit";
