/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import { Event, type IChannel, type IChannelClient } from "@lcode/rpc";
import { IRuntimeEnvironmentService } from "@lcode/services";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";

test("runtime proxies keep the target Host, workspace identity and expected generation", async () => {
  const calls: { host: string; channel: string; method: string; args: unknown }[] = [];
  const connect = (host: string) =>
    new RemoteServiceAccess({
      getChannel: (channel: string) =>
        ({
          call: async (method: string, args: unknown) => {
            calls.push({ host, channel, method, args });
            return null;
          },
          listen: () => Event.None,
        }) as IChannel,
    } as IChannelClient).runtimeEnvironmentService;
  const a = connect("host-a");
  const b = connect("host-b");
  const scope = { workspacePath: "/repo", workspaceIdentity: "identity-b" };
  const environmentId = "b".repeat(32);
  await a.getCapabilities({ ...scope, workspaceIdentity: "identity-a" });
  await b.snapshot({ ...scope, environmentId });
  await b.startService({
    ...scope,
    environmentId,
    requestId: "request-b",
    serviceId: "web",
    expectedRevision: 4,
    expectedGeneration: 7,
  });
  assert.deepEqual(
    calls.map(({ host }) => host),
    ["host-a", "host-b", "host-b"],
  );
  assert.ok(calls.every(({ channel }) => channel === IRuntimeEnvironmentService.channelName));
  assert.deepEqual(calls[2]!.args, [
    {
      ...scope,
      environmentId,
      requestId: "request-b",
      serviceId: "web",
      expectedRevision: 4,
      expectedGeneration: 7,
    },
  ]);
});

test("missing remote runtime channel never calls a local environment service", async () => {
  const error = new Error("Channel not found: runtime-environment");
  const service = new RemoteServiceAccess({
    getChannel: () =>
      ({
        call: async () => {
          throw error;
        },
        listen: () => Event.None,
      }) as IChannel,
  } as IChannelClient).runtimeEnvironmentService;
  await assert.rejects(
    service.getCapabilities({ workspacePath: "/repo", workspaceIdentity: "remote" }),
    (actual) => actual === error,
  );
});
