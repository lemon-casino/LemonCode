import { resolve } from "node:path";
import { createNodeLoggerFactory } from "@lcode/adapters/logging";
import { createConfig } from "@lcode/adapters/config";
import { createModelTelemetry } from "@lcode/telemetry";
import {
  createRootTraceContext,
  traceContextToLogContext,
  createSessionId,
} from "@lcode/contracts";
import { StartupTimer, startupNow } from "../startup-logging.js";
import type { LCodeAppOptions } from "./types.js";
import { createConfigCliOverrides, resolveEffectiveConfigResult } from "./app-config-options.js";
import { markConfigurationLoaded, startAppStartup } from "./startup-marks.js";

export function createAppStartupContext(options: LCodeAppOptions) {
  const startupStartedAt = startupNow();
  const appVersion = options.version ?? "0.0.0";
  const sessionId = options.sessionId ?? createSessionId();
  const traceContext = options.traceContext ?? createRootTraceContext({ sessionId });
  const workingDirectory = resolve(options.runtimeConfig?.workingDirectory ?? process.cwd());
  const configResult = resolveEffectiveConfigResult(
    createConfig({
      env: options.env,
      projectConfigPath: options.projectConfigPath,
      workingDirectory,
      workspaceIdentity: options.runtimeConfig?.memory?.workspaceIdentity,
      skipUserConfig: options.skipUserConfig,
      userConfigPath: options.userConfigPath,
      cliOverrides: createConfigCliOverrides(options),
    }),
    options,
  );
  const loggerFactory = options.loggerFactory ?? createNodeLoggerFactory({ env: options.env });
  const logger = loggerFactory.createLogger("lcode").child({
    ...traceContextToLogContext(traceContext),
    module: "bootstrap",
  });
  const startupTimer = new StartupTimer(
    logger,
    {
      ...traceContextToLogContext(traceContext),
      module: "bootstrap",
      startupKind: "lcode_app",
    },
    startupStartedAt,
  );
  startAppStartup({
    hasInjectedModelAdapter: options.modelAdapter !== undefined,
    resume: options.resume === true,
    startupTimer,
  });
  markConfigurationLoaded({
    configResult,
    startupTimer,
  });
  const modelLogger = loggerFactory.createLogger("lcode").child({
    ...traceContextToLogContext(traceContext),
    module: "adapters.model",
  });
  const modelTelemetry = createModelTelemetry({
    owner: options.telemetryOwner,
    sessionId,
  });
  return {
    options,
    appVersion,
    sessionId,
    traceContext,
    workingDirectory,
    configResult,
    loggerFactory,
    logger,
    startupTimer,
    modelLogger,
    modelTelemetry,
  };
}

export type AppStartupContext = ReturnType<typeof createAppStartupContext>;
