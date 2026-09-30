/// <reference types="vite/client" />
import { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { useGitBackupOnboarding } from "@/hooks/useGitBackupOnboarding.js";
import { GitBackupWelcomeView } from "@/GitBackupWelcomeDialog.js";
import { GitBackupSectionController } from "@/settings/GitBackupSection.js";
import { fixture, platform, workspace, type Operation } from "./git-backup-service.js";
import "@lcode/ui/styles.css";

function WelcomeFixture({ onOpenSettings }: { onOpenSettings: () => void }) {
  const state = useGitBackupOnboarding(fixture.service, workspace, false, onOpenSettings);
  return state.open && !state.loading ? <GitBackupWelcomeView state={state} /> : null;
}

function FixtureApp() {
  const state = useSyncExternalStore(fixture.subscribe, fixture.snapshot);
  const pendingCount = useSyncExternalStore(fixture.subscribe, fixture.pendingCount);
  const [generation, setGeneration] = useState(0);
  const failure = useSyncExternalStore(fixture.subscribe, fixture.failureSnapshot);
  const backupFailure = useSyncExternalStore(fixture.subscribe, fixture.backupFailureSnapshot);
  const [held, setHeld] = useState<Operation | "none">("none");
  const [mode, setMode] = useState("settings");
  const [connection, setConnection] = useState("ready");
  const [theme, setTheme] = useState("dark");
  const reset = () => {
    fixture.reset();
    setHeld("none");
    setGeneration((value) => value + 1);
  };
  return (
    <PlatformProvider platform={platform}>
      <LCodeIntlProvider initialLocale="zh-CN">
        <main className="fixture-page text-ui-base">
          <h1 className="text-ui-lg font-medium">Git 备份交互回归测试</h1>
          <div className="fixture-controls" aria-label="测试控制台">
            <Button variant="outline" size="sm" onClick={reset} data-testid="fixture-reset">
              重置测试
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setGeneration((value) => value + 1)}
              data-testid="fixture-reopen"
            >
              重新打开
            </Button>
            <label>
              显示模式
              <select
                aria-label="显示模式"
                value={mode}
                onChange={(event) => {
                  setMode(event.target.value);
                  setGeneration((value) => value + 1);
                }}
              >
                <option value="settings">设置</option>
                <option value="welcome">首次引导</option>
              </select>
            </label>
            <label>
              主题
              <select
                aria-label="主题"
                value={theme}
                onChange={(event) => {
                  const next = event.target.value;
                  setTheme(next);
                  document.documentElement.className =
                    next === "dark" ? "dark theme-zai-dark" : "theme-zai-light";
                }}
              >
                <option value="dark">深色</option>
                <option value="light">浅色</option>
              </select>
            </label>
            <label>
              连接
              <select
                aria-label="连接"
                value={connection}
                onChange={(event) => {
                  setConnection(event.target.value);
                  setGeneration((value) => value + 1);
                }}
              >
                <option value="ready">可用</option>
                <option value="disconnected">远端断开</option>
              </select>
            </label>
            <label>
              模拟下一次失败
              <select
                aria-label="模拟下一次失败"
                value={failure}
                onChange={(event) => {
                  const next = event.target.value as typeof failure;
                  fixture.setFailure(next);
                }}
              >
                <option value="none">无</option>
                <option value="load">读取配置</option>
                <option value="configure">保存、开关或清除</option>
                <option value="readback">提交成功后读回失败</option>
                <option value="test">测试连接 HTTP 403</option>
                <option value="backup">手动备份</option>
                <option value="export">私钥导出</option>
                <option value="onboarding">引导完成</option>
              </select>
            </label>
            <label>
              备份目的地失败
              <select
                aria-label="备份目的地失败"
                value={backupFailure}
                onChange={(event) =>
                  fixture.setBackupFailure(event.target.value as typeof backupFailure)
                }
              >
                <option value="none">无</option>
                <option value="oss">仅 OSS HTTP 403</option>
                <option value="minio">仅 MinIO HTTP 403</option>
              </select>
            </label>
            <label>
              挂起请求
              <select
                aria-label="挂起请求"
                value={held}
                onChange={(event) => {
                  const next = event.target.value as typeof held;
                  setHeld(next);
                  fixture.setHeld(next);
                }}
              >
                <option value="none">无</option>
                <option value="test">测试连接</option>
                <option value="backup">手动备份</option>
                <option value="load">读取配置</option>
                <option value="export">私钥导出</option>
              </select>
            </label>
            <Button
              variant="outline"
              size="sm"
              disabled={!pendingCount}
              onClick={() => fixture.release()}
              data-testid="fixture-release"
            >
              释放请求 ({pendingCount})
            </Button>
          </div>
          <section
            className="fixture-state"
            aria-label="服务已接受状态"
            data-testid="fixture-accepted-state"
          >
            <h2 className="text-ui-base font-medium">服务已接受状态</h2>
            <dl>
              <dt>enabled</dt>
              <dd data-testid="accepted-enabled">{String(state.config.enabled)}</dd>
              <dt>workspace count</dt>
              <dd data-testid="accepted-workspace-count">{state.config.workspaces.length}</dd>
              <dt>interval minutes</dt>
              <dd data-testid="accepted-interval">{state.config.intervalMinutes}</dd>
              <dt>bucket</dt>
              <dd data-testid="accepted-bucket">{state.config.oss?.bucket ?? "none"}</dd>
              <dt>MinIO bucket</dt>
              <dd data-testid="accepted-minio-bucket">{state.config.minio?.bucket ?? "none"}</dd>
              <dt>OSS selected</dt>
              <dd data-testid="accepted-oss-selected">
                {String(state.config.destinationEnabled?.oss)}
              </dd>
              <dt>MinIO selected</dt>
              <dd data-testid="accepted-minio-selected">
                {String(state.config.destinationEnabled?.minio)}
              </dd>
              <dt>OSS last success / error</dt>
              <dd data-testid="accepted-oss-result">
                {state.status.destinations?.oss?.lastBackupAt ?? "none"} /{" "}
                {state.status.destinations?.oss?.error ?? "none"}
              </dd>
              <dt>MinIO last success / error</dt>
              <dd data-testid="accepted-minio-result">
                {state.status.destinations?.minio?.lastBackupAt ?? "none"} /{" "}
                {state.status.destinations?.minio?.error ?? "none"}
              </dd>
              <dt>running</dt>
              <dd data-testid="accepted-running">{String(state.status.running)}</dd>
              <dt>last backup</dt>
              <dd data-testid="accepted-last-backup">{state.status.lastBackupAt ?? "none"}</dd>
              <dt>backup files</dt>
              <dd data-testid="accepted-files">{state.status.lastBackupFiles}</dd>
              <dt>onboarding complete</dt>
              <dd data-testid="accepted-onboarding">{String(state.onboardingComplete)}</dd>
            </dl>
          </section>
          {mode === "welcome" ? (
            <WelcomeFixture
              key={`welcome-${generation}`}
              onOpenSettings={() => setMode("settings")}
            />
          ) : (
            <GitBackupSectionController
              key={`settings-${generation}`}
              service={connection === "ready" ? fixture.service : null}
              target={workspace}
              connectionKind={connection === "ready" ? "local-ready" : "remote-waiting"}
            />
          )}
        </main>
      </LCodeIntlProvider>
    </PlatformProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Fixture root is missing");
createRoot(root).render(<FixtureApp />);
