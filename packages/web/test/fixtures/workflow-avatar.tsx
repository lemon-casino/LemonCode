import { useState } from "react";
import { createRoot } from "react-dom/client";
import { applyTheme, THEME_OPTIONS } from "@lcode/ui/useTheme";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { WorkflowAgentFace } from "@/components/workflow-timeline/WorkflowAgentFace.js";
import { WorkflowAgentPill } from "@/components/workflow-timeline/WorkflowAgentPill.js";
import { WorkflowMoreRow } from "@/components/workflow-timeline/WorkflowMoreRow.js";
import { AvatarCluster } from "@/app-shell/WorkflowRunSpineParts.js";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import type { TimelinePill } from "@/components/workflow-timeline/timeline-model.js";
import { checkReducedAvatarMotion, checkWorkflowAvatars } from "./workflow-avatar-checks.js";
import "@lcode/ui/styles.css";

const states: readonly StepRunStatus[] = ["pending", "running", "done", "cancelled", "failed"];
const labels = {
  pending: "待开始",
  running: "运行中",
  done: "已完成",
  cancelled: "已停止",
  failed: "已失败",
};
const pills: TimelinePill[] = states.map((status, avatarIndex) => ({
  key: status,
  lane: { id: `avatar-${status}`, laneClass: "agent", name: labels[status] },
  laneClass: "agent",
  avatarIndex,
  status,
  stepIds: [],
}));

function Fixture() {
  const [status, setStatus] = useState<StepRunStatus>("running");
  const [opened, setOpened] = useState("尚未打开");
  const [checks, setChecks] = useState("尚未检查");
  const verify = (reduced: boolean) => {
    try {
      setChecks(JSON.stringify(reduced ? checkReducedAvatarMotion() : checkWorkflowAvatars()));
    } catch (error) {
      setChecks(`失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return (
    <LCodeIntlProvider initialLocale="zh-CN">
      <main className="wf-motion h-full overflow-auto bg-background p-4 text-ui-base text-foreground">
        <div className="mx-auto flex max-w-5xl flex-col gap-5">
          <header>
            <h1 className="text-ui-xl font-semibold">D2 三叶小机灵 · 正式组件</h1>
            <p className="mt-1 text-ui-sm text-foreground-subtle">
              敲键盘、小雨、高跳；外侧光环留有间距，停止时保留静态光环。
            </p>
          </header>
          <section aria-label="界面主题" className="flex flex-wrap gap-2">
            {THEME_OPTIONS.map((theme) => (
              <button
                className="rounded-lg border border-border bg-surface px-3 py-1 text-ui-sm"
                type="button"
                key={theme.id}
                onClick={() => applyTheme(theme.id)}
              >
                {theme.id}
              </button>
            ))}
          </section>
          <section
            aria-label="五态对照"
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5"
          >
            {states.map((state, index) => (
              <article
                key={state}
                aria-label={`${labels[state]}头像`}
                data-fixture-state={state}
                className="flex min-w-0 flex-col items-center gap-3 rounded-xl border border-card-border bg-card p-3"
              >
                <h2 className="text-ui-base font-medium">{labels[state]}</h2>
                <WorkflowAgentFace
                  avatarIndex={index}
                  name="三叶小机灵"
                  status={state}
                  className="size-24"
                />
                <div className="w-full" data-fixture-size="md">
                  <WorkflowAgentPill
                    name="规范检查小搭档"
                    avatarIndex={index}
                    laneClass="agent"
                    status={state}
                  />
                </div>
                <div className="w-full" data-fixture-size="row">
                  <WorkflowAgentPill
                    name="规范检查小搭档"
                    avatarIndex={index}
                    laneClass="agent"
                    status={state}
                    size="row"
                  />
                </div>
              </article>
            ))}
          </section>
          <section aria-label="状态切换" className="flex flex-wrap items-center gap-2">
            {states.map((state) => (
              <button
                className="rounded-lg border border-border bg-surface px-3 py-1 text-ui-sm"
                type="button"
                key={state}
                onClick={() => setStatus(state)}
              >
                切换{labels[state]}
              </button>
            ))}
            <div className="w-44" data-testid="avatar-switch-target">
              <WorkflowAgentPill
                name="这是一个需要截断的很长代理名字"
                avatarIndex={8}
                laneClass="agent"
                status={status}
                open={{ label: "打开头像测试会话", onOpen: () => setOpened("已打开头像测试会话") }}
              />
            </div>
            <output aria-label="打开结果">{opened}</output>
          </section>
          <section aria-label="回归检查" className="flex flex-wrap items-center gap-2">
            <button
              className="rounded-lg border border-border bg-surface px-3 py-1 text-ui-sm"
              type="button"
              onClick={() => verify(false)}
            >
              检查当前主题与边界
            </button>
            <button
              className="rounded-lg border border-border bg-surface px-3 py-1 text-ui-sm"
              type="button"
              onClick={() => verify(true)}
            >
              检查减少动效
            </button>
            <output aria-label="检查结果" className="w-full break-all font-mono text-ui-xs">
              {checks}
            </output>
          </section>
          <section aria-label="折叠与更多头像" className="flex flex-wrap items-center gap-4">
            <AvatarCluster pills={pills.slice(0, 3)} nameOf={(pill) => pill.key} />
            <AvatarCluster pills={pills.slice(3)} nameOf={(pill) => pill.key} />
            <div className="w-64">
              <WorkflowMoreRow more={{ count: 8, deck: pills.slice(1, 4), failed: 0 }} />
            </div>
          </section>
        </div>
      </main>
    </LCodeIntlProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
