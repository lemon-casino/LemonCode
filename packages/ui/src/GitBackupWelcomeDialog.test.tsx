import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Dialog } from "./components/ui/dialog.js";
import enUS from "./i18n/locales/en-US.js";
import { GitBackupWelcomeView } from "./GitBackupWelcomeDialog.js";
import type { useGitBackupOnboarding } from "./hooks/useGitBackupOnboarding.js";

type Model = ReturnType<typeof useGitBackupOnboarding>;
type ElementProps = { children?: React.ReactNode; onClick?: () => void; disabled?: boolean };
function view(overrides: Partial<Model> = {}) {
  const actions: string[] = [];
  const state: Model = {
    open: true,
    ready: true,
    loading: false,
    busy: false,
    error: null,
    reload: async () => {
      actions.push("reload");
    },
    complete: async (action) => {
      actions.push(action);
    },
    ...overrides,
  };
  const internals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const previous = internals.H;
  internals.H = {
    useContext: () => ({
      intl: {
        formatMessage: ({ id }: { id: string }, values: Record<string, string> = {}) =>
          (enUS[id] ?? id).replace(/\{error\}/g, values.error ?? ""),
      },
    }),
  };
  let root: React.ReactElement<ElementProps>;
  try {
    root = GitBackupWelcomeView({ state }) as React.ReactElement<ElementProps>;
  } finally {
    internals.H = previous;
  }
  const content = root.props.children as React.ReactElement<ElementProps>;
  // Radix Portal 不输出 SSR HTML；将真实 content 子树保留 Dialog 上下文后渲染，而非伪造表单。
  const markup = renderToStaticMarkup(<Dialog open>{content.props.children}</Dialog>);
  const buttons: React.ReactElement<ElementProps>[] = [];
  function walk(node: React.ReactNode) {
    React.Children.forEach(node, (child) => {
      if (!React.isValidElement<ElementProps>(child)) return;
      if (child.props.onClick) buttons.push(child);
      walk(child.props.children);
    });
  }
  walk(content.props.children);
  return { actions, markup, buttons };
}

test("welcome describes both destinations and a settings handoff with no configuration inputs", () => {
  const { markup, buttons } = view();
  assert.match(markup, /OSS/);
  assert.match(markup, /MinIO/);
  assert.match(markup, /Settings/);
  assert.match(markup, /Data/);
  assert.doesNotMatch(markup, /<(?:input|select|textarea|form)\b/);
  assert.equal(buttons.length, 2);
});

test("welcome primary action immediately submits settings intent; skip never requests settings", () => {
  const { actions, buttons } = view();
  assert.ok(buttons[1] && buttons[0]);
  buttons[1].props.onClick?.();
  buttons[0].props.onClick?.();
  assert.deepEqual(actions, ["settings", "skip"]);
});

test("welcome completion failure shows details while read failure exposes reload and disables navigation", () => {
  assert.match(
    view({ error: "profile denied" }).markup,
    /Could not save onboarding completion: profile denied/,
  );
  const failed = view({ ready: false, error: "Host offline" });
  assert.match(failed.markup, /Host offline/);
  assert.match(failed.markup, /Retry/);
  assert.ok(failed.buttons[2] && failed.buttons[0]);
  assert.equal(failed.buttons[2].props.disabled, true);
  failed.buttons[0].props.onClick?.();
  assert.deepEqual(failed.actions, ["reload"]);
  const pending = view({ busy: true });
  assert.equal(
    pending.buttons.every((button) => button.props.disabled),
    true,
  );
});

test("Root uses existing gitBackup settings intent without replacing the complete workspace tab context", async () => {
  const source = await readFile(new URL("./Root.tsx", import.meta.url), "utf8");
  assert.match(source, /setPendingSettingsSection\("gitBackup"\)/);
  assert.match(source, /tabStoreApi\.getState\(\)\.openSettingsTab\(\)/);
  const welcome = source.slice(
    source.indexOf("<GitBackupWelcomeDialog"),
    source.indexOf("/>", source.indexOf("<GitBackupWelcomeDialog")),
  );
  assert.match(welcome, /onOpenSettings=\{handleOpenGitBackupSettings\}/);
  for (const [prop, owner] of [
    ["workspacePath", "workspaceShellPath"],
    ["workspaceIdentity", "workspaceShellIdentity"],
    ["remoteSessionId", "workspaceShellRemoteSessionId"],
    ["remoteTarget", "workspaceShellRemoteTarget"],
  ])
    assert.ok(welcome.includes(`${prop}={${owner}}`));
});
