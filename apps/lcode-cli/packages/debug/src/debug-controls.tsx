import { Database, FileJson, Radio } from "lucide-react";
import type { ProjectSummary, SourceStatus, TraceSummary } from "./shared";
import { type DebugView, viewLabels } from "./debug-view-model";
import { type ObservationEventState, useDelayedVisible } from "./observation-hooks";
import { formatTime } from "./debug-format";

export function ViewTabs(props: { activeView: DebugView; onChange: (view: DebugView) => void }) {
  return (
    <nav className="view-tabs" aria-label="调试视图">
      {(Object.keys(viewLabels) as DebugView[]).map((view) => (
        <button
          aria-current={props.activeView === view ? "page" : undefined}
          className={props.activeView === view ? "active" : ""}
          key={view}
          onClick={() => props.onChange(view)}
          type="button"
        >
          {viewLabels[view]}
        </button>
      ))}
    </nav>
  );
}

export function ProjectSelect(props: {
  projects: ProjectSummary[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span>项目</span>
      <select value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        <option value="">全部项目</option>
        {props.projects.map((project) => (
          <option key={project.projectId} value={project.projectId}>
            {project.label}（{project.sessionCount}）
          </option>
        ))}
      </select>
    </label>
  );
}

export function TraceSelect(props: {
  traces: TraceSummary[];
  value: string;
  onChange: (traceId: string) => void;
}) {
  return (
    <label>
      <span>Trace</span>
      <select value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        <option value="">选择 Trace</option>
        {props.traces.map((trace) => (
          <option key={trace.traceId} value={trace.traceId}>
            {trace.traceId} - {trace.firstUserMessage ?? "没有观察到用户消息"}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SourceBar({
  sources,
  loading,
  live,
}: {
  sources: SourceStatus[];
  loading: boolean;
  live: ObservationEventState;
}) {
  const showLoading = useDelayedVisible(loading, 180);
  return (
    <section className="source-bar" aria-label="观测数据源">
      <div className={`source-pill live ${live.connected ? "ready" : "muted"}`}>
        <Radio size={16} />
        <div>
          <strong>{live.connected ? "实时推送" : "实时重连"}</strong>
          <span>
            {live.lastChangeAt
              ? `最近更新 ${formatTime(live.lastChangeAt)}`
              : `${live.watchedPathCount} 个路径`}
          </span>
        </div>
        {live.error ? <small>{live.error}</small> : <small>SSE</small>}
      </div>
      {sources.map((source) => (
        <div className={`source-pill ${source.available ? "ready" : "muted"}`} key={source.kind}>
          {source.kind === "sqlite" ? <Database size={16} /> : <FileJson size={16} />}
          <div>
            <strong>{source.label}</strong>
            <span>{source.recordCount} 条记录</span>
          </div>
          {source.warning ? <small>{source.warning}</small> : null}
        </div>
      ))}
      <div className={`loading-dot ${showLoading ? "visible" : ""}`} aria-hidden={!showLoading}>
        加载中
      </div>
    </section>
  );
}
