import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import type { GitBackupConfig, IGitBackupService } from "@lcode/services";
import {
  completeGitBackupOnboarding,
  loadGitBackupOnboarding,
  useGitBackupOnboarding,
} from "./useGitBackupOnboarding.js";

const config: GitBackupConfig = {
  enabled: true,
  intervalMinutes: 60,
  oss: {
    accessKeyId: "example-id",
    accessKeySecret: "",
    bucket: "example-bucket",
    region: "oss-cn-hangzhou",
  },
  minio: {
    accessKeyId: "minio-id",
    accessKeySecret: "",
    bucket: "minio-bucket",
    endpoint: "https://storage.example:9000",
    region: "us-east-1",
  },
  destinationEnabled: { oss: true, minio: true },
  workspaces: [{ workspacePath: "/work/existing", workspaceIdentity: "existing-remote" }],
};
const workspace = { workspacePath: "/work/example", workspaceIdentity: "remote-example" };

function fixture() {
  const calls: unknown[] = [];
  const items = new Map<string, string>();
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    removeItem: (key: string) => {
      calls.push(["remove", key]);
      items.delete(key);
    },
  };
  const service = {
    hasCompletedOnboarding: async () => false,
    getConfig: async () => config,
    configure: async (...args: unknown[]) => {
      calls.push(["configure", ...args]);
    },
    markOnboardingComplete: async () => {
      calls.push(["complete"]);
    },
  } as unknown as IGitBackupService;
  return { calls, items, storage, service };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// 仓库没有 DOM / react-test-renderer 测试依赖；只替换 dispatcher 驱动本 hook 的真实状态与 effect 生命周期。
function mountHook<T>(renderHook: () => T) {
  const internals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const slots: Array<{ value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }> = [];
  let cursor = 0;
  let effects: Array<() => void> = [];
  const next = () => slots[cursor++] ?? (slots[cursor - 1] = {});
  const changed = (before: readonly unknown[] | undefined, after: readonly unknown[]) =>
    !before ||
    before.length !== after.length ||
    before.some((item, index) => !Object.is(item, after[index]));
  const dispatcher = {
    useState(initial: unknown) {
      const slot = next();
      if (!("value" in slot)) slot.value = typeof initial === "function" ? initial() : initial;
      return [
        slot.value,
        (value: unknown) => {
          slot.value = typeof value === "function" ? value(slot.value) : value;
        },
      ];
    },
    useRef(initial: unknown) {
      const slot = next();
      if (!("value" in slot)) slot.value = { current: initial };
      return slot.value;
    },
    useMemo(factory: () => unknown, deps: readonly unknown[]) {
      const slot = next();
      if (changed(slot.deps, deps)) {
        slot.value = factory();
        slot.deps = deps;
      }
      return slot.value;
    },
    useCallback(callback: unknown, deps: readonly unknown[]) {
      return dispatcher.useMemo(() => callback, deps);
    },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const slot = next();
      if (changed(slot.deps, deps)) {
        slot.deps = deps;
        effects.push(() => {
          slot.cleanup?.();
          slot.cleanup = effect() ?? undefined;
        });
      }
    },
  };
  return {
    render() {
      cursor = 0;
      const previous = internals.H;
      internals.H = dispatcher;
      try {
        return renderHook();
      } finally {
        internals.H = previous;
      }
    },
    effects() {
      const pending = effects;
      effects = [];
      for (const effect of pending) effect();
    },
    unmount() {
      for (const slot of slots) slot.cleanup?.();
    },
  };
}

async function mountOnboarding(service: IGitBackupService, onOpenSettings = () => {}) {
  let currentWorkspace = workspace;
  let currentService = service;
  const hook = mountHook(() =>
    useGitBackupOnboarding(currentService, currentWorkspace, false, onOpenSettings),
  );
  hook.render();
  hook.effects();
  await new Promise<void>((resolve) => setImmediate(resolve));
  return {
    ...hook,
    switchWorkspace(next: typeof workspace) {
      currentWorkspace = next;
      hook.render();
      hook.effects();
    },
    switchService(next: IGitBackupService) {
      currentService = next;
      hook.render();
      hook.effects();
    },
  };
}

test("welcome only reads completion, leaving legacy credentials for settings", async () => {
  const f = fixture();
  f.items.set("git-backup-config", JSON.stringify(config));
  f.service.getConfig = async () => {
    throw new Error("welcome must not read configuration");
  };
  assert.deepEqual(await loadGitBackupOnboarding(f.service, f.storage), { complete: false });
  assert.deepEqual(f.calls, []);
  assert.ok(f.items.has("git-backup-config"));
});

test("legacy completion migrates only the marker and does not configure destinations", async () => {
  const f = fixture();
  f.items.set("git-backup-onboarding-done", "1");
  f.items.set("git-backup-config", JSON.stringify(config));
  assert.deepEqual(await loadGitBackupOnboarding(f.service, f.storage), { complete: true });
  assert.deepEqual(f.calls, [["complete"], ["remove", "git-backup-onboarding-done"]]);
  assert.ok(f.items.has("git-backup-config"));
});

test("completion preserves enabled state, both destinations, credentials and registered workspaces", async () => {
  const f = fixture();
  f.items.set("git-backup-config", JSON.stringify(config));
  await completeGitBackupOnboarding(f.service, f.storage);
  assert.deepEqual(f.calls, [["complete"], ["remove", "git-backup-onboarding-done"]]);
  assert.deepEqual(await f.service.getConfig(), config);
  assert.ok(f.items.has("git-backup-config"));
});

test("failed legacy marker migration keeps marker and credentials intact", async () => {
  const f = fixture();
  f.items.set("git-backup-config", JSON.stringify(config));
  f.items.set("git-backup-onboarding-done", "1");
  f.service.markOnboardingComplete = async () => {
    throw new Error("read-only profile");
  };
  await assert.rejects(loadGitBackupOnboarding(f.service, f.storage), /read-only profile/);
  assert.equal(f.items.get("git-backup-onboarding-done"), "1");
  assert.ok(f.items.has("git-backup-config"));
});

test("remote onboarding does not consume the local-only legacy marker", async () => {
  const f = fixture();
  f.items.set("git-backup-onboarding-done", "1");
  assert.deepEqual(await loadGitBackupOnboarding(f.service, null), { complete: false });
  assert.deepEqual(f.calls, []);
  assert.equal(f.items.get("git-backup-onboarding-done"), "1");
});

test("blocked browser cleanup cannot turn committed onboarding into a failed action", async () => {
  const f = fixture();
  f.storage.removeItem = () => {
    throw new Error("browser storage blocked");
  };
  await completeGitBackupOnboarding(f.service, f.storage);
  assert.deepEqual(f.calls, [["complete"]]);
});

test("settings action waits for Host completion, closes and navigates once without configuring", async () => {
  const f = fixture();
  const pending = deferred();
  const navigation: string[] = [];
  f.service.markOnboardingComplete = () => {
    f.calls.push(["complete"]);
    return pending.promise;
  };
  const hook = await mountOnboarding(f.service, () => navigation.push("settings"));
  const action = hook.render().complete;
  const first = action("settings");
  await action("settings");
  assert.equal(hook.render().open, true);
  assert.equal(hook.render().busy, true);
  assert.deepEqual(navigation, []);
  pending.resolve();
  await first;
  assert.equal(hook.render().open, false);
  assert.deepEqual(navigation, ["settings"]);
  await action("settings");
  assert.deepEqual(f.calls, [["complete"]]);
  assert.deepEqual(navigation, ["settings"]);
  hook.unmount();
});

test("skip completes and closes without navigation or workspace registration", async () => {
  const f = fixture();
  const navigation: string[] = [];
  const hook = await mountOnboarding(f.service, () => navigation.push("settings"));
  await hook.render().complete("skip");
  assert.equal(hook.render().open, false);
  assert.deepEqual(navigation, []);
  assert.deepEqual(f.calls, [["complete"]]);
  hook.unmount();
});

test("completion failure leaves dialog open with error and retry navigates only after success", async () => {
  const f = fixture();
  const navigation: string[] = [];
  let fail = true;
  f.service.markOnboardingComplete = async () => {
    f.calls.push(["complete"]);
    if (fail) throw new Error("profile denied");
  };
  const hook = await mountOnboarding(f.service, () => navigation.push("settings"));
  await hook.render().complete("settings");
  assert.equal(hook.render().open, true);
  assert.equal(hook.render().error, "profile denied");
  assert.equal(hook.render().busy, false);
  assert.deepEqual(navigation, []);
  fail = false;
  await hook.render().complete("settings");
  assert.equal(hook.render().open, false);
  assert.deepEqual(navigation, ["settings"]);
  hook.unmount();
});

test("load failure remains retryable and settings navigation is unavailable until a successful read", async () => {
  const f = fixture();
  const navigation: string[] = [];
  f.service.hasCompletedOnboarding = async () => {
    throw new Error("Host offline");
  };
  const hook = await mountOnboarding(f.service, () => navigation.push("settings"));
  assert.equal(hook.render().ready, false);
  assert.equal(hook.render().error, "Host offline");
  await hook.render().complete("settings");
  assert.deepEqual(f.calls, []);
  f.service.hasCompletedOnboarding = async () => false;
  await hook.render().reload();
  assert.equal(hook.render().ready, true);
  assert.equal(hook.render().error, null);
  await hook.render().complete("settings");
  assert.deepEqual(navigation, ["settings"]);
  hook.unmount();
});

for (const transition of ["unmount", "workspace", "Host", "reload"] as const) {
  test(`late completion after ${transition} never closes a new scope or navigates`, async () => {
    const f = fixture();
    const pending = deferred();
    const navigation: string[] = [];
    f.service.markOnboardingComplete = () => pending.promise;
    const hook = await mountOnboarding(f.service, () => navigation.push("settings"));
    const first = hook.render().complete("settings");
    if (transition === "unmount") hook.unmount();
    else if (transition === "workspace")
      hook.switchWorkspace({ ...workspace, workspaceIdentity: "different-remote-same-path" });
    else if (transition === "Host") hook.switchService(fixture().service);
    else await hook.render().reload();
    await new Promise<void>((resolve) => setImmediate(resolve));
    pending.resolve();
    await first;
    assert.deepEqual(navigation, []);
    if (transition !== "unmount") {
      assert.equal(hook.render().open, true);
      hook.unmount();
    }
  });
}

test("late failure does not overwrite the new workspace error or busy state", async () => {
  const f = fixture();
  const pending = deferred();
  f.service.markOnboardingComplete = () => pending.promise;
  const hook = await mountOnboarding(f.service);
  const first = hook.render().complete("settings");
  hook.switchWorkspace({ ...workspace, workspaceIdentity: "different-remote-same-path" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  pending.reject(new Error("old Host failure"));
  await first;
  assert.equal(hook.render().error, null);
  assert.equal(hook.render().busy, false);
  assert.equal(hook.render().open, true);
  hook.unmount();
});
