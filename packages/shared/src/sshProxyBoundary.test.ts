import assert from "node:assert/strict";
import test from "node:test";
import {
  hostConnectRemoteWorkspaceMessageSchema,
  appSettingsSchema,
  remoteTargetSchema,
  windowHostRemoteWorkspaceDescriptorSchema,
} from "./validation.js";
import {
  createWindowWorkspaceCatalogTarget,
  windowWorkspaceCatalogSchema,
} from "./windowWorkspace.js";

const ssh = { kind: "ssh" as const, host: "fixture.invalid", username: "fixture" };

test("SSH proxy selection survives the shared connect and Host message boundaries", () => {
  for (const selection of [
    {},
    { useProxy: false },
    { useProxy: true },
    { useProxy: true, proxyProfileId: "fixture-profile" },
  ]) {
    const target = { ...ssh, ...selection };
    assert.deepEqual(remoteTargetSchema.parse(target), target);
    assert.deepEqual(
      hostConnectRemoteWorkspaceMessageSchema.parse({
        type: "connect-remote-workspace",
        requestId: "fixture-request",
        target,
        remoteAssets: {},
      }).target,
      target,
    );
    assert.deepEqual(
      windowHostRemoteWorkspaceDescriptorSchema.parse({
        remoteSessionId: "fixture-session",
        target,
        generation: 1,
      }).target,
      target,
    );
  }
});

test("SSH proxy fields reject invalid values at every connect boundary", () => {
  for (const selection of [
    { useProxy: "true" },
    { proxyProfileId: 1 },
    { proxyProfileId: "" },
    { proxyProfileId: "   " },
  ]) {
    const target = { ...ssh, ...selection };
    assert.equal(remoteTargetSchema.safeParse(target).success, false);
    assert.equal(
      hostConnectRemoteWorkspaceMessageSchema.safeParse({
        type: "connect-remote-workspace",
        requestId: "fixture-request",
        target,
        remoteAssets: {},
      }).success,
      false,
    );
  }
});

test("persisted targets derive connection fields while excluding temporary secrets", () => {
  for (const selection of [
    {},
    { useProxy: false },
    { useProxy: true },
    { useProxy: true, proxyProfileId: "fixture-profile" },
  ]) {
    const target = { ...ssh, ...selection };
    const settings = appSettingsSchema.parse({
      lastWorkspaceSession: [
        {
          kind: "remote",
          workspacePath: "/fixture",
          lastOpenedAt: 1,
          lastConnectionStatus: "failed",
          target: {
            ...target,
            password: "fixture-secret",
            privateKeyPassphrase: "fixture-passphrase",
            passwordCredentialKey: "fixture-credential",
          },
        },
      ],
    });
    const saved = settings.lastWorkspaceSession[0];
    assert.ok(saved?.kind === "remote" && saved.target.kind === "ssh");
    assert.equal(saved.target.passwordCredentialKey, "fixture-credential");
    assert.equal("password" in saved.target, false);
    assert.equal("privateKeyPassphrase" in saved.target, false);
    assert.deepEqual(remoteTargetSchema.parse(saved.target), target);
  }
});

test("proxied SSH catalog projection preserves display identity without connection options", () => {
  const target = {
    ...ssh,
    port: 22,
    sshConfigAlias: "Fixture SSH",
    useProxy: true,
    proxyProfileId: "fixture-profile",
    password: "fixture-password",
    privateKeyPath: "/fixture/key",
    privateKeyPassphrase: "fixture-passphrase",
    passwordCredentialKey: "fixture-credential-key",
    assetInstallMode: "local-download-upload" as const,
  };
  const before = structuredClone(target);
  const projected = createWindowWorkspaceCatalogTarget(target);
  assert.deepEqual(projected, {
    ...ssh,
    port: 22,
    sshConfigAlias: "Fixture SSH",
  });
  const entry = {
    scope: {
      kind: "remote",
      remoteSessionId: "fixture-session",
      workspacePath: "/fixture",
      workspaceIdentity: "fixture-identity",
      generation: 1,
    },
    target: projected,
    sourceAvailability: "online",
  };
  assert.equal(windowWorkspaceCatalogSchema.safeParse([entry]).success, true);
  assert.equal(windowWorkspaceCatalogSchema.safeParse([{ ...entry, target }]).success, false);
  assert.deepEqual(target, before, "the connection owner keeps the selected proxy");
  for (const legacy of [
    ssh,
    { kind: "wsl" as const, distro: "Fixture", user: "fixture" },
    { kind: "docker" as const, container: "fixture" },
  ])
    assert.equal(
      windowWorkspaceCatalogSchema.safeParse([
        { ...entry, target: createWindowWorkspaceCatalogTarget(legacy) },
      ]).success,
      true,
    );
});
