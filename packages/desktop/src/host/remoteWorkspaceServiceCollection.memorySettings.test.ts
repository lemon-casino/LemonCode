import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Emitter } from "@lcode/rpc";
import { ISettingService, type IServiceAccessor } from "@lcode/services";
import { setDataBaseDir, disposeServiceResourcesAndWait } from "@lcode/services/node";
import type { LCodeSessionRequestRuntimePreferencesParams } from "@lcode/shared";
import { createRemoteWorkspaceServiceCollection } from "./remoteWorkspaceServiceCollection.js";

test(
  "external desktop authority does not propagate local workspace memory location to the remote Agent",
  { timeout: 10_000 },
  async (t) => {
    t.mock.method(console, "log", () => {});
    const directory = await mkdtemp(join(tmpdir(), "lcode-remote-memory-settings-"));
    const previous = process.env.LCODE_DESKTOP_HOME_DIR;
    process.env.LCODE_DESKTOP_HOME_DIR = directory;
    setDataBaseDir(directory);
    const requests = new Emitter<
      LCodeSessionRequestRuntimePreferencesParams & { requestId: string }
    >();
    type Response = Parameters<
      IServiceAccessor["lcodeAgentService"]["respondSessionRuntimePreferences"]
    >[0];
    let receive!: (response: Response) => void;
    let fail!: (error: unknown) => void;
    const required = [
      "fileService",
      "gitService",
      "gitCheckpointService",
      "systemService",
      "terminalService",
      "lcodeTaskService",
      "lcodeSessionService",
      "fileWatcherService",
      "skillsService",
      "skillSyncService",
      "mcpSyncService",
      "pluginSyncService",
      "pluginsService",
      "pluginManagementService",
      "commandsService",
      "hooksService",
      "modelSelectionService",
      "providerSettingsService",
    ];
    const connectionServices = {
      ...Object.fromEntries(required.map((key) => [key, {}])),
      lcodeAgentService: {
        onDynamicSessionRuntimePreferencesRequest: () => requests.event,
        respondSessionRuntimePreferences: async (response: Response) => receive(response),
        disposeAllAndWait: async () => {},
        disposeAll: () => {},
      },
    } as unknown as IServiceAccessor;
    const collection = createRemoteWorkspaceServiceCollection({
      connectionServices,
      parentPort: null,
      clientConfigService: {} as IServiceAccessor["clientConfigService"],
      promptAttachmentTransferService: {} as IServiceAccessor["promptAttachmentTransferService"],
      createReportingRemoteLCodeTaskService: (service) => service,
      createRemotePromptAttachmentTaskService: (service) => service,
      createRemotePromptAttachmentSessionService: (service) => service,
      runtimePreferencesBridge: { onError: (error) => fail(error) },
    });
    try {
      await collection.get(ISettingService).update({
        memoryStorageLocation: "workspace",
        memoryStorageRevision: 1,
        memoryEnabled: true,
      });
      assert.equal(
        (await collection.get(ISettingService).get()).memoryStorageLocation,
        "workspace",
      );
      assert.equal((await collection.get(ISettingService).get()).memoryStorageRevision, 1);
      for (const scope of ["runtime-materialization", "user-execution"] as const) {
        const response = new Promise<Response>((resolve, reject) => {
          receive = resolve;
          fail = reject;
        });
        requests.fire({ requestId: scope, sessionId: "remote-session", scope });
        const result = await response;
        assert.ok(result.resolution.status === "resolved");
        assert.equal(result.resolution.preferences.memoryEnabled, true);
        assert.equal(Object.hasOwn(result.resolution.preferences, "memoryStorageLocation"), false);
        assert.equal(Object.hasOwn(result.resolution.preferences, "memoryStorageRevision"), false);
      }
    } finally {
      requests.dispose();
      await disposeServiceResourcesAndWait(collection);
      setDataBaseDir(null);
      if (previous === undefined) delete process.env.LCODE_DESKTOP_HOME_DIR;
      else process.env.LCODE_DESKTOP_HOME_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
