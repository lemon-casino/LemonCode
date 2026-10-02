/// <reference types="vite/client" />
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ToolCallGetWorkflowRunDisplay } from "@lcode/shared/lcode-protocol-v4";
import { LCodeIntlProvider, useLCodeIntl } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { WorkflowRunDigest } from "@/components/workflow-timeline/WorkflowRunDigest.js";
import { WorkflowRunPhaseList } from "@/app-shell/WorkflowRunPhaseList.js";
import { WorkflowPermissionBlock } from "@/WorkflowPermissionBlock.js";
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";
import { workflowProjectionDisplay } from "@/components/workflow-timeline/timeline-activity.js";
import { ConversationStatusPanel } from "@/v4/ConversationStatusPanel.js";
import { WorkflowRunSubagentRoster } from "@/ToolCallBlocks/renderers/get-workflow-run-roster.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import {
  graph,
  progressPermission,
  scenarios,
  type ProgressScenario,
} from "./workflow-execution-progress-data.js";
import {
  beginRecovery,
  failRecovery,
  finishRecovery,
  initialise,
  lease,
  sendScene,
  sendStaleFrame,
  sourceNow,
} from "./workflow-execution-progress-runtime.js";
import "@lcode/ui/styles.css";

function App() {
  const { locale, setLocale } = useLCodeIntl();
  const state = useConversationProjection(lease);
  const [profile, setProfile] = useState("desktop-continuous");
  const [selected, setSelected] = useState<ProgressScenario>("model");
  const [opened, setOpened] = useState("none");
  const [cancelled, setCancelled] = useState("none");
  const [panelVariant, setPanelVariant] = useState<"panel" | "mini" | null>("panel");
  const [dark, setDark] = useState(false);
  const [advice, setAdvice] = useState<"valid" | "stale" | "none">("valid");
  useEffect(() => {
    void initialise();
    return () => lease.release();
  }, []);
  const run = state.snapshot?.workflowRuns?.runs[0];
  const display = useMemo(
    () => workflowProjectionDisplay({ status: state.status, syncing: state.syncing }),
    [state.status, state.syncing],
  );
  const model = useMemo(() => buildWorkflowTimeline(graph, run, display), [run, display]);
  const roster = useMemo<NonNullable<ToolCallGetWorkflowRunDisplay["subagents"]>>(() => {
    if (run === undefined) return [];
    return run.actors.map<NonNullable<ToolCallGetWorkflowRunDisplay["subagents"]>[number]>(
      (actor) => {
        const nodes = run.nodes.filter(
          (node) => node.actorSiteId === actor.siteId && node.actorOrdinal === actor.ordinal,
        );
        const current = nodes.find((node) => node.phase !== "settled") ?? nodes.at(-1);
        const live = run.status === "running" || run.status === "pending";
        const lastDeliveredAt = nodes.reduce<number | undefined>(
          (latest, node) =>
            node.phase === "settled" &&
            node.outcome === "ok" &&
            node.cached !== true &&
            node.settledAt !== undefined
              ? Math.max(latest ?? 0, node.settledAt)
              : latest,
          undefined,
        );
        return {
          siteId: actor.siteId,
          ordinal: actor.ordinal,
          name: actor.name,
          state: !live
            ? run.status === "completed"
              ? "done"
              : run.status === "errored"
                ? "failed"
                : "unfinished"
            : current === undefined
              ? "idle"
              : current.phase === "settled"
                ? "done"
                : ["queued", "dispatched", "paused", "waiting"].includes(current.phase)
                  ? "waiting"
                  : "executing",
          askPhase: current?.phase,
          phaseName: current?.phaseName,
          activity: current?.activity,
          queue: current?.queue,
          waitCause: current?.wait?.cause,
          waitSince: current?.wait?.since,
          waitReason: current?.wait?.reason,
          retryAttempt: current?.wait?.attempt,
          nextRetryAt: current?.wait?.nextRetryAt,
          lastDeliveredAt,
          stepsSettled: nodes.filter((node) => node.phase === "settled").length,
          stepsFailed: nodes.filter((node) => node.outcome === "failed").length,
          tokens: 0,
        };
      },
    );
  }, [run]);
  const controlClass =
    "rounded-lg border border-border bg-surface px-2 py-1 text-ui-sm text-foreground";
  return (
    <main
      className="min-h-dvh min-w-0 max-w-full space-y-4 bg-background p-3 text-foreground"
      data-testid="workflow-progress-fixture"
    >
      <h1 className="text-ui-lg font-medium">Workflow execution progress</h1>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <label className="text-ui-sm">
          Scenario{" "}
          <select
            aria-label="Scenario"
            className={controlClass}
            value={selected}
            onChange={(event) => {
              const next = event.target.value as ProgressScenario;
              setSelected(next);
              sendScene(next);
            }}
          >
            {scenarios.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="text-ui-sm">
          Profile{" "}
          <select
            aria-label="Profile"
            className={controlClass}
            value={profile}
            onChange={(event) => setProfile(event.target.value)}
          >
            <option>desktop-continuous</option>
            <option>web-remote-replayable</option>
          </select>
        </label>
        <button
          className={controlClass}
          onClick={() => setLocale(locale === "zh-CN" ? "en-US" : "zh-CN")}
          type="button"
        >
          {locale}
        </button>
        <button
          className={controlClass}
          onClick={() => {
            const next = !dark;
            setDark(next);
            document.documentElement.className = next ? "dark theme-zai-dark" : "theme-zai-light";
          }}
          type="button"
        >
          {dark ? "Dark" : "Light"}
        </button>
        <button className={controlClass} onClick={beginRecovery} type="button">
          Begin sync
        </button>
        <button
          className={controlClass}
          onClick={() => {
            void finishRecovery(profile);
          }}
          type="button"
        >
          Finish sync
        </button>
        <button className={controlClass} onClick={failRecovery} type="button">
          Connection error
        </button>
        <button
          className={controlClass}
          onClick={() => {
            void initialise();
          }}
          type="button"
        >
          Reconnect
        </button>
        <button className={controlClass} onClick={sendStaleFrame} type="button">
          Stale frame
        </button>
      </div>
      <p
        className="break-words text-ui-xs text-foreground-subtle"
        data-testid="fixture-projection-state"
      >
        {state.status} · syncing={String(state.syncing)} · seq={state.snapshot?.seq ?? "none"} ·
        source={run?.nodes[0]?.activity?.observedAt ?? "unknown"}
      </p>
      <p className="break-words text-ui-sm" data-testid="fixture-opened">
        Opened: {opened}
      </p>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <div className="min-w-0" data-testid="fixture-card">
          <WorkflowRunDigest
            name="Execution progress"
            runId="fixture-progress"
            graph={graph}
            display={display}
            testIdKey="fixture"
            pendingQuestions={run?.pendingQuestions?.length ?? 0}
            summary={
              run === undefined
                ? undefined
                : {
                    runId: run.runId,
                    status: run.status,
                    nodesSettled: run.nodes.filter((node) => node.phase === "settled").length,
                    nodesTotal: run.nodes.length,
                    agents: run.actors.length,
                    run,
                  }
            }
            onOpenPill={(pill) => setOpened(`actor ${pill.slot?.siteId}@${pill.slot?.ordinal}`)}
            onOpenRun={() => setOpened("run details")}
          />
        </div>
        <section
          className="flex min-h-0 min-w-0 flex-col rounded-xl border border-border"
          data-testid="fixture-details"
        >
          <h2 className="px-3 pt-2 text-ui-base font-medium">Run details</h2>
          <WorkflowRunPhaseList
            graph={graph}
            model={model}
            run={run}
            pendingQuestions={run?.pendingQuestions ?? []}
            onOpenActor={(actor) => setOpened(`actor ${actor.siteId}@${actor.ordinal}`)}
          />
        </section>
      </div>
      <section className="relative min-h-72 min-w-0" data-testid="fixture-status-panel">
        <ConversationStatusPanel
          workspacePath="/fixture/workflow"
          parentSessionId="fixture-parent"
          workflowRuns={state.snapshot?.workflowRuns?.runs}
          workflowDisplay={display}
          backgroundWorks={
            run === undefined || (run.status !== "running" && run.status !== "pending")
              ? []
              : [
                  {
                    workId: run.runId,
                    kind: "workflow",
                    status: "running",
                    title: "Execution progress",
                    startedAt: sourceNow - 30_000,
                    anchorRowId: null,
                    cancellable: true,
                  },
                ]
          }
          summaryPanelVariantOverride={panelVariant}
          onVariantChange={(value) =>
            setPanelVariant(value === "panel" || value === "mini" ? value : null)
          }
          workflowSectionOpen
          endedWorkflowRunCount={
            run !== undefined && run.status !== "running" && run.status !== "pending" ? 1 : 0
          }
          onOpenWorkflowRun={() => setOpened("status run details")}
          onOpenWorkflowRunDirectory={() => setOpened("status run directory")}
          onCancelBackgroundWork={setCancelled}
        />
      </section>
      <p className="text-ui-sm" data-testid="fixture-cancelled">
        Cancelled: {cancelled}
      </p>
      <section
        className="min-w-0 rounded-xl border border-border p-3"
        data-testid="fixture-static-roster"
      >
        <WorkflowRunSubagentRoster subagents={roster} generatedAt={sourceNow} />
      </section>
      <section
        className="min-w-0 rounded-xl border border-border p-3"
        data-testid="fixture-permission"
      >
        <div className="mb-3 flex flex-wrap gap-2">
          {(["valid", "stale", "none"] as const).map((value) => (
            <button
              className={controlClass}
              onClick={() => setAdvice(value)}
              key={value}
              type="button"
            >
              Advice {value}
            </button>
          ))}
        </div>
        <WorkflowPermissionBlock request={progressPermission(advice)} />
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <LCodeIntlProvider initialLocale="zh-CN">
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </LCodeIntlProvider>,
);
