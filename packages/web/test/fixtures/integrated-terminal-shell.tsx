import { useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  IntegratedTerminalShellOption,
  IntegratedTerminalShellSelection,
} from "@lcode/shared";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { IntegratedTerminalShellControl } from "@/settings/IntegratedTerminalShellControl.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";
import "@/styles.css";

const fixture = {
  file: "/opt/自定义 Shell/my-shell" as string | null,
  failSave: false,
  holdResolve: false,
  resolveCalls: 0,
  releaseResolve: () => {},
  saves: [] as IntegratedTerminalShellSelection[],
};
Object.assign(window, { __shellFixture: fixture });
const option = (
  path: string,
  dialect: IntegratedTerminalShellOption["dialect"],
): IntegratedTerminalShellOption => ({
  path,
  dialect,
  id: `${dialect}:${path}`,
  label: path.split("/").at(-1)!,
  source: "path",
});

function Fixture() {
  const [selection, setSelection] = useState<IntegratedTerminalShellSelection>({ mode: "auto" });
  const [mounted, setMounted] = useState(true);
  const web = new URLSearchParams(location.search).has("web");
  return (
    <main className="w-full max-w-3xl p-4">
      <button type="button" onClick={() => setMounted(false)}>
        Unmount
      </button>
      {mounted ? (
        <SettingsRow
          label="Integrated terminal shell"
          description="Choose an installed shell or a custom executable."
          controlLayout="wide"
          control={
            <IntegratedTerminalShellControl
              selection={selection}
              options={[]}
              loading={false}
              onRefresh={async () => {}}
              onChange={async (value) => {
                if (fixture.failSave) throw new Error("fixture save failure");
                fixture.saves.push(value);
                setSelection(value);
              }}
              onResolvePath={async (path) => {
                fixture.resolveCalls += 1;
                if (fixture.holdResolve)
                  await new Promise<void>((resolve) => {
                    fixture.releaseResolve = resolve;
                  });
                if (path === "/opt/shells")
                  return [option(`${path}/bin/bash`, "posix"), option(`${path}/bin/fish`, "fish")];
                if (path === "/opt/自定义 Shell/my-shell") return [option(path, "custom")];
                return [];
              }}
              onSelectFile={web ? undefined : async () => fixture.file}
              onSelectDirectory={web ? undefined : async () => "/opt/shells"}
            />
          }
        />
      ) : null}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <LCodeIntlProvider
    initialLocale={new URLSearchParams(location.search).has("english") ? "en-US" : "zh-CN"}
  >
    <Fixture />
  </LCodeIntlProvider>,
);
