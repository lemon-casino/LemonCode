/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import { Event, type IChannel, type IChannelClient } from "@lcode/rpc";
import { IGitBackupService } from "@lcode/services";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";

test("Git backup proxy preserves workspace identity and the target registration argument", async () => {
  const calls: Array<{ channel: string; method: string; args: unknown }> = [];
  const channelClient: IChannelClient = {
    getChannel<T extends IChannel>(channel: string): T {
      return {
        async call<T>(method: string, args?: unknown): Promise<T> {
          calls.push({ channel, method, args });
          return undefined as T;
        },
        listen: () => Event.None,
      } as unknown as T;
    },
  };
  const services = new RemoteServiceAccess(channelClient);
  const workspace = { workspacePath: "/projects/repo", workspaceIdentity: "remote-repo" };

  await services.gitBackupService.configure({ enabled: true }, workspace, {
    completeOnboarding: true,
  });
  await services.gitBackupService.startBackup(workspace.workspacePath, workspace.workspaceIdentity);
  await services.gitBackupService.getStatus();

  assert.deepEqual(calls, [
    {
      channel: IGitBackupService.channelName,
      method: "configure",
      args: [{ enabled: true }, workspace, { completeOnboarding: true }],
    },
    {
      channel: IGitBackupService.channelName,
      method: "startBackup",
      args: [workspace.workspacePath, workspace.workspaceIdentity],
    },
    { channel: IGitBackupService.channelName, method: "getStatus", args: [] },
  ]);
});

test("Git backup proxy forwards independent destination patches and explicit MinIO operations", async () => {
  const calls: Array<{ method: string; args: unknown }> = [];
  const channelClient: IChannelClient = {
    getChannel<T extends IChannel>(): T {
      return {
        async call<T>(method: string, args?: unknown): Promise<T> {
          calls.push({ method, args });
          return undefined as T;
        },
        listen: () => Event.None,
      } as unknown as T;
    },
  };
  const service = new RemoteServiceAccess(channelClient).gitBackupService;
  const minio = {
    endpoint: "https://minio.example.invalid:9000",
    accessKeyId: "fixture-id",
    accessKeySecret: "fixture-secret",
    bucket: "fixture-bucket",
    region: "us-east-1",
  };
  await service.configure({ minio, destinationEnabled: { minio: true } });
  await service.testConnection(minio, "minio");
  await service.startBackup("/projects/repo", "remote-repo", "minio");
  assert.deepEqual(calls, [
    { method: "configure", args: [{ minio, destinationEnabled: { minio: true } }] },
    { method: "testConnection", args: [minio, "minio"] },
    { method: "startBackup", args: ["/projects/repo", "remote-repo", "minio"] },
  ]);
});

test("an old Host without Git backup reports its RPC error instead of simulated success", async () => {
  const unavailable = new Error("Channel not found: git-backup");
  const channelClient: IChannelClient = {
    getChannel<T extends IChannel>(): T {
      return {
        call: () => Promise.reject(unavailable),
        listen: () => Event.None,
      } as unknown as T;
    },
  };
  const services = new RemoteServiceAccess(channelClient);

  await assert.rejects(services.gitBackupService.getConfig(), (error) => error === unavailable);
});
