import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsSchema } from "@lcode/shared";
import { buildRemoteTarget } from "./remoteConnectionWizard.js";
import {
  createRemoteTargetFromSnapshot,
  buildRemoteWorkspaceSessionMutation,
} from "./remoteWorkspaceHistory.js";

const form = {
  kind: "ssh" as const,
  host: "fixture.invalid",
  port: "22",
  username: "fixture",
  sshAuthMethod: "password" as const,
  password: "fixture-secret",
  privateKeyPath: "",
  privateKeyPassphrase: "",
  wslDistro: "",
  dockerContainer: "",
};
const intl = { formatMessage: ({ id }: { id: string }) => id };

test("SSH proxy selection submits and restores the saved profile ID without credentials", () => {
  const { target } = buildRemoteTarget(intl, {
    ...form,
    sshProxySelection: { kind: "profile", profileId: "fixture-profile" },
  });
  assert.equal(target?.kind === "ssh" && target.useProxy, true);
  assert.equal(target?.kind === "ssh" && target.proxyProfileId, "fixture-profile");
  assert.ok(target);
  const mutation = buildRemoteWorkspaceSessionMutation({
    remoteSessions: [],
    workspacePath: "/fixture",
    target,
    lastConnectionStatus: "connected",
    touchOpenedAt: true,
  });
  assert.equal(mutation.entry.target.kind === "ssh" && mutation.entry.target.useProxy, true);
  assert.equal(
    mutation.entry.target.kind === "ssh" && mutation.entry.target.proxyProfileId,
    "fixture-profile",
  );
  const saved = appSettingsSchema.parse({ lastWorkspaceSession: [mutation.entry] });
  assert.equal(
    saved.lastWorkspaceSession[0]?.kind === "remote" &&
      saved.lastWorkspaceSession[0].target.kind === "ssh" &&
      saved.lastWorkspaceSession[0].target.useProxy,
    true,
  );
  assert.equal(
    saved.lastWorkspaceSession[0]?.kind === "remote" &&
      saved.lastWorkspaceSession[0].target.kind === "ssh" &&
      saved.lastWorkspaceSession[0].target.proxyProfileId,
    "fixture-profile",
  );
  assert.equal(
    appSettingsSchema.safeParse({
      lastWorkspaceSession: [
        { ...mutation.entry, target: { ...mutation.entry.target, proxyProfileId: "" } },
      ],
    }).success,
    false,
  );
  assert.equal(
    appSettingsSchema.safeParse({
      lastWorkspaceSession: [
        { ...mutation.entry, target: { ...mutation.entry.target, useProxy: "true" } },
      ],
    }).success,
    false,
  );
  assert.equal(JSON.stringify(mutation.entry).includes("fixture-secret"), false);
  const restored = createRemoteTargetFromSnapshot(mutation.entry.target, {
    password: null,
    privateKeyPassphrase: null,
  });
  assert.equal(restored.kind === "ssh" && restored.useProxy, true);
  assert.equal(restored.kind === "ssh" && restored.proxyProfileId, "fixture-profile");
  const direct = buildRemoteTarget(intl, {
    ...form,
    sshProxySelection: { kind: "direct" },
  }).target;
  assert.equal(direct?.kind === "ssh" && Boolean(direct.useProxy), false);
  assert.equal(direct?.kind === "ssh" && direct.proxyProfileId, undefined);
  const defaultProxy = buildRemoteTarget(intl, {
    ...form,
    sshProxySelection: { kind: "default" },
  }).target;
  assert.equal(defaultProxy?.kind === "ssh" && defaultProxy.useProxy, true);
  assert.equal(defaultProxy?.kind === "ssh" && defaultProxy.proxyProfileId, undefined);
  const legacy = createRemoteTargetFromSnapshot(
    { kind: "ssh", host: "fixture.invalid", username: "fixture" },
    { password: null, privateKeyPassphrase: null },
  );
  assert.equal(legacy.kind === "ssh" && Boolean(legacy.useProxy), false);
});
