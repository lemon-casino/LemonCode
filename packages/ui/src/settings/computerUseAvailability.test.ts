import assert from "node:assert/strict";
import test from "node:test";
import { buildRemoteWorkspaceIdentity, type RemoteTarget } from "@zcode/shared";
import {
  isComputerUseUnavailableNonWeb,
  resolveComputerUseAvailability,
} from "./computerUseAvailability.js";

test("本机 macOS、Windows 与 Linux desktop 均开放 Computer Use", () => {
  const cases = [
    {
      input: { isDesktop: true, isMacDesktop: true },
      expectedKind: "local-macos",
    },
    {
      input: { isDesktop: true, isWindowsDesktop: true },
      expectedKind: "local-windows",
    },
    {
      input: { isDesktop: true },
      expectedKind: "local-linux",
    },
  ] as const;

  for (const { input, expectedKind } of cases) {
    const availability = resolveComputerUseAvailability(input);
    assert.deepEqual(availability, { kind: expectedKind, supported: true });
    assert.equal(isComputerUseUnavailableNonWeb(availability), false);
  }
});

test("Web 与所有远端 workspace 保持不可用，远端身份优先于本机平台", () => {
  const targets: RemoteTarget[] = [
    { kind: "ssh", host: "example.invalid", username: "test" },
    { kind: "wsl", distro: "Ubuntu" },
    { kind: "docker", container: "test-container" },
  ];

  assert.deepEqual(resolveComputerUseAvailability(), { kind: "web", supported: false });
  assert.equal(isComputerUseUnavailableNonWeb(resolveComputerUseAvailability()), false);

  for (const target of targets) {
    const availability = resolveComputerUseAvailability({
      isDesktop: true,
      isWindowsDesktop: true,
      remoteTarget: target,
    });
    assert.deepEqual(availability, { kind: `remote-${target.kind}`, supported: false });
    assert.equal(isComputerUseUnavailableNonWeb(availability), true);
  }

  assert.deepEqual(
    resolveComputerUseAvailability({ isDesktop: true, remoteSessionId: "remote-session" }),
    { kind: "remote-server", supported: false },
  );
  assert.deepEqual(
    resolveComputerUseAvailability({
      isDesktop: true,
      workspaceIdentity: buildRemoteWorkspaceIdentity("/workspace", targets[0]!),
    }),
    { kind: "remote-server", supported: false },
  );
});
