import { updateUiLocaleInFileConfig } from "@lcode/adapters/config";
import { resolveLocale } from "@lcode/i18n";
import {
  traceContextToLogContext,
  type CollaborationMode,
  type MessageId,
  type UiThemePreference,
} from "@lcode/contracts";
import { listMcpServerStatuses } from "../mcp-config.js";
import { loadSessionTranscriptFromStore } from "../session-transcript.js";
import { createSubagentObservation } from "./subagent-observation.js";
import { getLocaleConfigPath } from "./locale-selection.js";
import type { CreateSessionFacadeDeps, SessionFacade } from "./session-facade-types.js";
import { createSessionModelFacade } from "./session-model-facade.js";
import { createSessionGoalFacade } from "./session-goal-facade.js";
import { closeSessionFacadeResources } from "./session-resource-close.js";

export function createSessionFacade(deps: CreateSessionFacadeDeps): SessionFacade {
  let closePromise: Promise<void> | undefined;
  let currentLocale = resolveLocale(deps.configResult.config.ui.locale);

  return {
    close: async () => {
      closePromise ??= closeSessionFacadeResources(deps);
      return await closePromise;
    },
    getMode: () => deps.runtime.getMode(),
    ...createSessionModelFacade(deps),
    getLocale: () => currentLocale,
    getTheme: () => deps.configResult.config.ui.theme as UiThemePreference,

    loadSessionTranscript: async () =>
      await loadSessionTranscriptFromStore({
        sessionId: deps.sessionId,
        sessionStore: deps.sessionStore,
      }),
    ...createSubagentObservation(deps),
    readTodos: async () => deps.sessionStore.readTodos({ sessionID: deps.sessionId }),
    ...createSessionGoalFacade(deps),
    setCustomSessionTitle: async (input) =>
      deps.runtime.setCustomSessionTitle({
        title: input.title,
        traceContext: input.traceContext ?? deps.traceContext,
      }),

    listMcpServers: async () =>
      listMcpServerStatuses(
        deps.mcpPort,
        deps.configuredMcpServers,
        deps.untrustedProjectMcpServers,
      ),
    connectMcpServer: async (name) => {
      const config = deps.configuredMcpServers[name];
      if (!config) {
        throw new Error(`MCP server is not configured: ${name}`);
      }
      if (!deps.mcpPort) {
        throw new Error("MCP is disabled");
      }
      return deps.mcpPort.connectServer(name, config, {
        trace: deps.traceContext,
        workingDirectory: deps.workingDirectory,
      });
    },
    readBackgroundBashOutput: (workId, sessionId) =>
      deps.runtime.readBackgroundBashOutput(workId, sessionId),
    cancelBackgroundTask: async (taskId, options) =>
      deps.runtime.cancelBackgroundTask(taskId, {
        traceContext: options?.traceContext ?? deps.traceContext,
      }),
    disconnectMcpServer: async (name) => {
      if (!deps.mcpPort) return undefined;
      return deps.mcpPort.disconnectServer(name);
    },
    listCheckpoints: async (options) => {
      await deps.prepareResume();
      return deps.runtime.listWorkspaceCheckpoints(options);
    },
    forkFromCheckpoint: async (options) => {
      await deps.prepareResume(options?.traceContext);
      return deps.runtime.forkWorkspaceFromCheckpoint({
        targetCheckpointId: options?.targetCheckpointId,
        targetMessageId: options?.targetMessageId as MessageId | undefined,
        traceContext: options?.traceContext ?? deps.traceContext,
      });
    },

    setMode: async (mode: CollaborationMode) => {
      const previousMode = deps.runtime.getMode();
      await deps.runtime.setExecutionState({ mode }, deps.traceContext);
      if (deps.localSettingStore) {
        try {
          await deps.localSettingStore.saveProjectPermissionMode({
            mode: deps.runtime.getMode(),
            projectID: deps.projectID,
          });
        } catch (error) {
          deps.logger.warn("Project mode preference write failed", {
            ...traceContextToLogContext(deps.traceContext),
            error: error instanceof Error ? error.message : String(error),
            event: "local_setting.permission_mode.write_failed",
            mode,
            module: "bootstrap",
            projectId: deps.projectID,
            status: "failed",
          });
        }
      }
      deps.logger.info("Session mode updated", {
        ...traceContextToLogContext(deps.traceContext),
        event: "session.mode.updated",
        mode,
        module: "bootstrap",
        previousMode,
        status: "completed",
      });
      return {
        mode: deps.runtime.getMode(),
        previousMode,
        traceId: deps.traceContext.traceId,
      };
    },

    setLocale: async (locale) => {
      const previousLocale = currentLocale;
      const configPath = getLocaleConfigPath(deps.configResult);
      const persisted = await updateUiLocaleInFileConfig(configPath, locale);
      currentLocale = deps.resolveUiLocale(locale);
      deps.configResult.config.ui.locale = currentLocale;
      deps.logger.info("Session locale updated", {
        ...traceContextToLogContext(deps.traceContext),
        event: "session.locale.updated",
        locale: currentLocale,
        module: "bootstrap",
        previousLocale,
        requestedLocale: locale,
        status: "completed",
      });
      return {
        configPath: persisted.path,
        locale: currentLocale,
        previousLocale,
        requestedLocale: locale,
        traceId: deps.traceContext.traceId,
      };
    },
  };
}
