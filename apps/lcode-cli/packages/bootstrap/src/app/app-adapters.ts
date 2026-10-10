import { join } from "node:path";
import { createNodeToolArtifactStore } from "@lcode/adapters/storage";
import { resolvePath } from "@lcode/adapters/config";
import { createNodeExecutionAdapter } from "@lcode/adapters/exec";
import { createNodeFileSystemAdapter } from "@lcode/adapters/fs";
import { createNodeWebFetchHttpClientAdapter } from "@lcode/adapters/http";
import { createJimpImageProcessorAdapter } from "@lcode/adapters/image";
import { createPopplerPdfDocumentAdapter } from "@lcode/adapters/pdf";
import { createNodeVideoProcessorAdapter } from "@lcode/adapters/video";
import { createNodeSessionMailboxAdapter } from "@lcode/adapters/mailbox";
import { createMcpAdapter } from "@lcode/adapters/mcp";
import { PermissionService } from "@lcode/core";
import { isMessageEnabled } from "./app-config-options.js";
import { createProjectScopedExecutionPort } from "./project-environment-execution.js";
import {
  createProjectEnvironmentCloseBarrier,
  createProjectScopedMcpPort,
} from "./project-environment-mcp.js";
import { asInputHistoryStore } from "./session-store.js";
import {
  debugRuntimeConfigResolved,
  markMcpAdapterInitialized,
  markStorageAdaptersInitialized,
} from "./startup-marks.js";
import type { AppStartupContext } from "./app-startup-context.js";
import type { PreparedAppConfiguration } from "./app-configuration.js";

export function createAppAdapters(
  startup: AppStartupContext,
  configuration: PreparedAppConfiguration,
) {
  const { options, configResult, logger, appVersion, startupTimer } = startup;
  const { storageRoot, cliStorageRoot, sessionStore, configuredMcpServers, runtimeConfig } =
    configuration;
  const { workingDirectory } = startup;
  const permissionService = new PermissionService({
    allowedTools: new Set(configResult.config.permission.allowedTools),
    autoApproveHighRisk: configResult.config.permission.autoApproveHighRisk,
    disallowedTools: new Set(configResult.config.permission.disallowedTools),
    allowMediumRiskInAutoMode: configResult.config.permission.allowMediumRiskInAuto,
  });
  const inputHistoryStore = options.inputHistoryStore ?? asInputHistoryStore(sessionStore);
  const artifactStore =
    options.artifactStore ??
    createNodeToolArtifactStore({
      imageCacheRootDir: join(storageRoot, "cli", "image-cache"),
      pdfCacheRootDir: join(storageRoot, "cli", "pdf-cache"),
      rootDir: join(storageRoot, "cli", "artifacts"),
      videoCacheRootDir: join(storageRoot, "cli", "video-cache"),
    });
  const imageProcessorPort = options.imageProcessorPort ?? createJimpImageProcessorAdapter();
  const messageEnabled = isMessageEnabled(options.env ?? process.env);
  const sessionMailboxPort =
    options.sessionMailboxPort ??
    (messageEnabled
      ? createNodeSessionMailboxAdapter({
          rootDir: resolvePath(
            (options.env ?? process.env).LCODE_MAILBOX_ROOT ?? "~/.lcode/mailbox",
          ),
        })
      : undefined);
  markStorageAdaptersInitialized({
    cliStorageRoot,
    hasInjectedArtifactStore: options.artifactStore !== undefined,
    hasInjectedSessionStore: options.sessionStore !== undefined,
    startupTimer,
    storageRoot,
  });
  const rawMcpPort =
    options.mcpPort ??
    (runtimeConfig.mcp?.enabled === false
      ? undefined
      : (options.mcpPortFactory?.({ workingDirectory }) ??
        createMcpAdapter({
          clientVersion: appVersion,
          env: options.env,
          logger,
          network: {
            httpProxy: configResult.config.network.httpProxy,
            noProxy: configResult.config.network.noProxy,
            caCertFile: configResult.config.network.caCertFile,
          },
          workingDirectory,
        })));
  const ownsMcpPort = options.mcpPort === undefined && rawMcpPort !== undefined;
  const ownsExecutionPort = options.executionPort === undefined;
  // Session 资源并行关闭；只有实际由本 app 拥有的 owner 才能参加 release barrier。
  const environmentOwnerNames = [
    ...(ownsExecutionPort ? (["execution"] as const) : []),
    ...(ownsMcpPort ? (["mcp"] as const) : []),
  ];
  const environmentOwners =
    options.resolveProjectEnvironmentOverlay && environmentOwnerNames.length > 0
      ? createProjectEnvironmentCloseBarrier(
          options.resolveProjectEnvironmentOverlay,
          environmentOwnerNames,
        )
      : undefined;
  const mcpResolver = environmentOwners?.mcp ?? options.resolveProjectEnvironmentOverlay;
  const mcpPort =
    rawMcpPort && mcpResolver
      ? createProjectScopedMcpPort(rawMcpPort, mcpResolver, {
          workingDirectory,
          environmentRef:
            options.projectEnvironmentRef ?? runtimeConfig.workspaceBinding?.environmentRef,
        })
      : rawMcpPort;
  const rawExecutionPort =
    options.executionPort ??
    createNodeExecutionAdapter({
      onToolExecResource: options.onToolExecResource,
      network: {
        httpProxy: configResult.config.network.httpProxy,
        noProxy: configResult.config.network.noProxy,
        caCertFile: configResult.config.network.caCertFile,
      },
      outputRootDir: join(storageRoot, "cli", "exec"),
      processEnv: options.env ?? process.env,
    });
  const executionPort =
    environmentOwners && ownsExecutionPort
      ? createProjectScopedExecutionPort(rawExecutionPort, environmentOwners.execution)
      : rawExecutionPort;
  const pdfDocumentPort =
    options.pdfDocumentPort ?? createPopplerPdfDocumentAdapter({ executionPort });
  const videoProcessorPort =
    options.videoProcessorPort ?? createNodeVideoProcessorAdapter({ executionPort });
  // browser-use 控制端口：仅当宿主（desktop）注入时可用，无本地 fallback（纯 CLI 无浏览器底座）。
  const fileSystemPort = options.fileSystemPort ?? createNodeFileSystemAdapter();
  const httpClientPort =
    options.httpClientPort ??
    createNodeWebFetchHttpClientAdapter({
      env: options.env ?? process.env,
      timeoutMs: configResult.config.network.timeout,
      proxyUrl: configResult.config.network.httpProxy,
      noProxy: configResult.config.network.noProxy,
      caCertFile: configResult.config.network.caCertFile,
    });
  markMcpAdapterInitialized({
    configuredMcpServers,
    hasInjectedMcpPort: options.mcpPort !== undefined,
    mcpEnabled: runtimeConfig.mcp?.enabled !== false,
    startupTimer,
    trustedMcpServerCount: Object.keys(runtimeConfig.mcp?.servers ?? {}).length,
  });
  debugRuntimeConfigResolved({
    configResult,
    logger,
    runtimeConfig,
  });
  return {
    permissionService,
    inputHistoryStore,
    artifactStore,
    imageProcessorPort,
    sessionMailboxPort,
    mcpPort,
    ownsMcpPort,
    executionPort,
    ownsExecutionPort,
    pdfDocumentPort,
    videoProcessorPort,
    fileSystemPort,
    httpClientPort,
  };
}

export type AppAdapters = ReturnType<typeof createAppAdapters>;
