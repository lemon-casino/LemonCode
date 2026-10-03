/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import { Event, type IChannel, type IChannelClient } from "@lcode/rpc";
import { IWorktreeService } from "@lcode/services";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";

test("same-path remote worktrees use the selected Host channel and preserve identity on every scoped request", async () => {
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
    } as IChannelClient).worktreeService;
  const a = connect("host-a"),
    b = connect("host-b");
  await a.prepare({
    workspacePath: "/repo",
    workspaceIdentity: "identity-a",
    taskId: "A",
    requestId: "A",
  });
  await b.prepare({
    workspacePath: "/repo",
    workspaceIdentity: "identity-b",
    taskId: "B",
    requestId: "B",
  });
  await b.getBinding({ workspacePath: "/repo", workspaceIdentity: "identity-b", taskId: "B" });
  await b.publishIntegration({ operationId: "operation-b", approvedCandidateHead: "candidate-b" });
  assert.deepEqual(
    calls.map((call) => call.host),
    ["host-a", "host-b", "host-b", "host-b"],
  );
  assert.ok(calls.every((call) => call.channel === IWorktreeService.channelName));
  assert.equal(
    (calls[0]!.args as [{ workspaceIdentity: string }])[0].workspaceIdentity,
    "identity-a",
  );
  assert.equal(
    (calls[2]!.args as [{ workspaceIdentity: string }])[0].workspaceIdentity,
    "identity-b",
  );
});

test("an old remote Host rejects unsupported worktree capabilities without a local fallback", async () => {
  const error = new Error("Channel not found: worktree");
  const service = new RemoteServiceAccess({
    getChannel: () =>
      ({
        call: async () => {
          throw error;
        },
        listen: () => Event.None,
      }) as IChannel,
  } as IChannelClient).worktreeService;
  await assert.rejects(
    service.getCapabilities({ workspacePath: "/repo", workspaceIdentity: "remote" }),
    (actual) => actual === error,
  );
});
