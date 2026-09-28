// Model factory - creates model adapter with config

import {
  AiSdkModelAdapter,
  type AiSdkModelExecutionConfig,
  type EnvRecord,
} from "@lcode/adapters/model";
import type { Logger, ModelStatusSink } from "@lcode/contracts";

interface CreateModelAdapterBaseOptions {
  env?: EnvRecord;
  logger?: Logger;
  modelIoDir?: string;
  modelIoFullRetentionEnabled?: boolean;
  streamIdleTimeoutMs?: number;
  statusSink?: ModelStatusSink;
}

export type CreateModelAdapterOptions = CreateModelAdapterBaseOptions & {
  executionConfig: AiSdkModelExecutionConfig;
};

export function createModelAdapter(options: CreateModelAdapterOptions): AiSdkModelAdapter {
  if (!options.executionConfig) {
    throw new Error("createModelAdapter requires executionConfig");
  }
  return new AiSdkModelAdapter({
    ...options.executionConfig,
    debugDir: options.modelIoDir,
    env: options.env,
    logger: options.logger,
    modelIoFullRetentionEnabled: options.modelIoFullRetentionEnabled,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs,
    statusSink: options.statusSink,
  });
}
