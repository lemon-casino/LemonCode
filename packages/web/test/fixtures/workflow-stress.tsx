/// <reference types="vite/client" />
import { Profiler, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { Button } from "@/components/ui/button.js";
import { WorkflowRunDigest } from "@/components/workflow-timeline/WorkflowRunDigest.js";
import { WorkflowRunPhaseList } from "@/app-shell/WorkflowRunPhaseList.js";
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";
import { workflowProjectionDisplay } from "@/components/workflow-timeline/timeline-activity.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { stressGraph } from "./workflow-stress-data.js";
import { BrowserStressController, type StressProfile } from "./workflow-stress-runtime.js";
import "@lcode/ui/styles.css";

function MeasuredWorkflow({
  controller,
  onOpen,
}: {
  controller: BrowserStressController;
  onOpen: (name: string) => void;
}) {
  const state = useConversationProjection(controller.lease);
  const run = state.snapshot?.workflowRuns?.runs[0];
  const display = useMemo(
    () => workflowProjectionDisplay({ status: state.status, syncing: state.syncing }),
    [state.status, state.syncing],
  );
  const model = useMemo(() => buildWorkflowTimeline(stressGraph, run, display), [run, display]);
  return (
    <Profiler id="shared-workflow" onRender={controller.metrics.onRender}>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2" data-testid="stress-shared-components">
        <div className="min-w-0">
          <WorkflowRunDigest
            name="Sustained synthetic actors"
            runId="stress-run"
            graph={stressGraph}
            display={display}
            testIdKey="stress"
            pendingQuestions={0}
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
            onOpenRun={() => onOpen("run details")}
            onOpenPill={(pill) => onOpen(`actor ${pill.slot?.ordinal ?? "unknown"}`)}
          />
        </div>
        <section className="min-w-0 rounded-xl border border-border" data-testid="stress-details">
          <h2 className="px-3 pt-2 text-ui-base font-medium">Run details</h2>
          <WorkflowRunPhaseList
            graph={stressGraph}
            model={model}
            run={run}
            pendingQuestions={[]}
            onOpenActor={(actor) => onOpen(`actor ${actor.ordinal}`)}
          />
        </section>
        <p className="break-words text-ui-sm" data-testid="stress-projection-state">
          {state.status} · syncing={String(state.syncing)} · actors={run?.actors.length ?? 0} ·
          nodes={run?.nodes.length ?? 0} · truncated={String(run?.truncated === true)}
        </p>
      </div>
    </Profiler>
  );
}

function App() {
  const [actors, setActors] = useState(12);
  const [profile, setProfile] = useState<StressProfile>("desktop-continuous");
  const [warmupMs, setWarmupMs] = useState(10_000);
  const [controller, setController] = useState<BrowserStressController | null>(null);
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [opened, setOpened] = useState("none");
  const [result, setResult] = useState<ReturnType<BrowserStressController["result"]> | null>(null);
  const current = useRef<BrowserStressController | null>(null);
  const statusTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const snapshot = () =>
    Object.freeze({
      buildMode: import.meta.env.DEV
        ? "vite-development-react-profiler"
        : "vite-production-profiler-may-be-disabled",
      measuredSurface: "shared WorkflowRunDigest/WorkflowTimeline and WorkflowRunPhaseList",
      uiStatusTimersRemaining: Number(statusTimer.current !== undefined),
      measuredComponentsMounted: running,
      result: current.current?.result() ?? null,
    });
  useEffect(() => {
    // 唯一全局出口是只读数字查询，不暴露 store/命令或新增业务状态。
    Object.defineProperty(window, "workflowStressResults", {
      configurable: true,
      get: () =>
        Object.freeze({
          buildMode: import.meta.env.DEV
            ? "vite-development-react-profiler"
            : "vite-production-profiler-may-be-disabled",
          uiStatusTimersRemaining: Number(statusTimer.current !== undefined),
          result: current.current?.result() ?? null,
        }),
    });
    return () => {
      if (statusTimer.current !== undefined) clearInterval(statusTimer.current);
      statusTimer.current = undefined;
      void current.current?.stop();
      Reflect.deleteProperty(window, "workflowStressResults");
    };
  }, []);
  const start = async () => {
    setStarting(true);
    try {
      await current.current?.stop();
      const next = new BrowserStressController(actors, profile, warmupMs);
      current.current = next;
      setController(next);
      setRunning(true);
      setOpened("none");
      await next.start();
      setResult(next.result());
      statusTimer.current = setInterval(() => setResult(next.result()), 1_000);
    } finally {
      setStarting(false);
    }
  };
  const stop = async () => {
    if (statusTimer.current !== undefined) clearInterval(statusTimer.current);
    statusTimer.current = undefined;
    await current.current?.stop();
    setRunning(false);
    setResult(current.current?.result() ?? null);
  };
  const controlClass =
    "rounded-lg border border-border bg-surface px-2 py-1 text-ui-sm text-foreground";
  const open = (name: string) => {
    if (current.current !== null) current.current.metrics.openedDetails++;
    setOpened(name);
  };
  return (
    <main
      className="min-h-dvh min-w-0 space-y-4 bg-background p-3 text-foreground"
      data-testid="workflow-stress-fixture"
    >
      <h1 className="text-ui-lg font-medium">Workflow sustained render benchmark</h1>
      <p className="text-ui-sm text-foreground-subtle">
        Synthetic data only. Real shared components and parent store. Node driver/wire measurements
        run separately. Build: {import.meta.env.MODE}; React Profiler{" "}
        {import.meta.env.DEV ? "enabled" : "check commits before claiming results"}.
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <label className="text-ui-sm">
          Scenario{" "}
          <select
            className={controlClass}
            aria-label="Scenario"
            data-testid="stress-scenario"
            disabled={running || starting}
            value={actors}
            onChange={(event) => setActors(Number(event.target.value))}
          >
            {[12, 64, 256].map((value) => (
              <option value={value} key={value}>
                {value} actors · 20 deltas/s
              </option>
            ))}
          </select>
        </label>
        <label className="text-ui-sm">
          Profile{" "}
          <select
            className={controlClass}
            aria-label="Profile"
            disabled={running || starting}
            value={profile}
            onChange={(event) => setProfile(event.target.value as StressProfile)}
          >
            <option>desktop-continuous</option>
            <option>web-remote-replayable</option>
          </select>
        </label>
        <label className="text-ui-sm">
          Warmup{" "}
          <select
            className={controlClass}
            aria-label="Warmup"
            disabled={running || starting}
            value={warmupMs}
            onChange={(event) => setWarmupMs(Number(event.target.value))}
          >
            <option value={10_000}>10 seconds</option>
            <option value={0}>0 (smoke only)</option>
          </select>
        </label>
        <Button
          type="button"
          data-testid="stress-start"
          disabled={running || starting}
          onClick={() => {
            void start();
          }}
        >
          Start
        </Button>
        <Button
          variant="outline"
          type="button"
          data-testid="stress-stop"
          disabled={!running}
          onClick={() => {
            void stop();
          }}
        >
          Stop
        </Button>
        <Button
          variant="outline"
          type="button"
          data-testid="stress-recover"
          disabled={!running}
          onClick={() => current.current?.recover()}
        >
          Recover
        </Button>
        <Button
          variant="outline"
          type="button"
          data-testid="stress-stale"
          disabled={!running}
          onClick={() => current.current?.stale()}
        >
          Stale frame
        </Button>
        <Button
          variant="outline"
          type="button"
          data-testid="stress-open"
          disabled={!running}
          onClick={() => open("run details")}
        >
          Open details
        </Button>
      </div>
      <p className="text-ui-base" data-testid="stress-status">
        {starting ? "starting" : (result?.phase ?? "idle")} · measured{" "}
        {Math.floor((result?.measuredWallMs ?? 0) / 1_000)}s · input {result?.inputDeltas ?? 0}
      </p>
      <p className="text-ui-sm" data-testid="stress-opened">
        Opened: {opened}
      </p>
      {running && controller !== null ? (
        <MeasuredWorkflow controller={controller} onOpen={open} />
      ) : (
        <p className="text-ui-sm">
          Shared components unmounted; source, RAF and subscriptions stopped.
        </p>
      )}
      <details className="min-w-0 rounded-xl border border-border p-3" open>
        <summary className="text-ui-base">Read-only numeric results</summary>
        <pre
          className="max-h-96 overflow-auto whitespace-pre-wrap break-all font-mono text-ui-sm"
          data-testid="stress-results"
        >
          {JSON.stringify({ ...snapshot(), result }, null, 2)}
        </pre>
      </details>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <LCodeIntlProvider initialLocale="en-US">
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </LCodeIntlProvider>,
);
