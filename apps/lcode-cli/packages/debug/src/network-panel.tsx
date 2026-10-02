import { AlertTriangle, Check, Clipboard, Globe2, Search, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { NetworkCaptureStatus, NetworkRequestRecord } from "./shared";
import {
  filterNetworkRequests,
  type EnvShell,
  formatEnvCommand,
  copyTextToClipboard,
  envShellLabels,
} from "./network-model";
import { PanelTitle, EmptyLine } from "./panel-parts";
import { formatNetworkStatus, formatTime, formatDuration, formatBytes } from "./debug-format";

export function NetworkPage(props: {
  activeTraceId: string;
  error: string | null;
  filter: string;
  onFilterChange: (value: string) => void;
  onTraceSelect: (traceId: string) => void;
  requests: NetworkRequestRecord[];
  status: NetworkCaptureStatus | null;
}) {
  const filteredRequests = useMemo(
    () => filterNetworkRequests(props.requests, props.filter),
    [props.filter, props.requests],
  );

  return (
    <div className="network-page">
      <section className="network-control-strip" aria-label="网络请求过滤">
        <label>
          <span>过滤</span>
          <div className="input-with-icon">
            <Search size={16} />
            <input
              value={props.filter}
              onChange={(event) => props.onFilterChange(event.target.value)}
              placeholder="trace、host、URL、method"
            />
          </div>
        </label>
        <button
          className="secondary-button"
          disabled={!props.activeTraceId}
          onClick={() => props.onFilterChange(props.activeTraceId)}
          type="button"
        >
          当前 Trace
        </button>
        <button
          className="secondary-button"
          disabled={!props.filter}
          onClick={() => props.onFilterChange("")}
          type="button"
        >
          清空
        </button>
      </section>
      <NetworkPanel
        activeTraceId={props.activeTraceId}
        error={props.error}
        requests={filteredRequests}
        status={props.status}
        onTraceSelect={props.onTraceSelect}
      />
    </div>
  );
}

function NetworkPanel(props: {
  activeTraceId: string;
  error: string | null;
  requests: NetworkRequestRecord[];
  status: NetworkCaptureStatus | null;
  onTraceSelect: (traceId: string) => void;
}) {
  const [envShell, setEnvShell] = useState<EnvShell>("posix");
  const [copiedShell, setCopiedShell] = useState<EnvShell | null>(null);
  const activeTraceCount = props.activeTraceId
    ? props.requests.filter((request) => request.traceId === props.activeTraceId).length
    : 0;
  const envCommand = useMemo(
    () => formatEnvCommand(props.status?.env ?? {}, envShell),
    [envShell, props.status?.env],
  );

  useEffect(() => {
    if (!copiedShell) return;
    const timer = window.setTimeout(() => setCopiedShell(null), 1600);
    return () => window.clearTimeout(timer);
  }, [copiedShell]);

  const copyEnvCommand = useCallback(async () => {
    if (!envCommand) return;
    await copyTextToClipboard(envCommand);
    setCopiedShell(envShell);
  }, [envCommand, envShell]);

  return (
    <section className="panel network-panel">
      <PanelTitle icon={<Globe2 size={17} />} title="网络请求" />
      {props.error ? (
        <div className="network-error">
          <AlertTriangle size={15} />
          <span>{props.error}</span>
        </div>
      ) : null}
      <div className="network-head">
        <div className={props.status?.running ? "network-state ready" : "network-state muted"}>
          <ShieldCheck size={16} />
          <div>
            <strong>{props.status?.running ? "代理运行中" : "代理未运行"}</strong>
            <span>{props.status?.proxyUrl ?? "未启用"}</span>
          </div>
        </div>
        <div className="network-stat">
          <span>最近请求</span>
          <strong>{props.requests.length}</strong>
        </div>
        <div className="network-stat">
          <span>当前 Trace</span>
          <strong>{activeTraceCount}</strong>
        </div>
        <div className="network-stat wide">
          <span>CA</span>
          <strong>{props.status?.certificate.caCertPath ?? "未生成"}</strong>
        </div>
      </div>
      {envCommand ? (
        <div className="env-copy-box">
          <div className="env-copy-toolbar">
            <div className="segmented-control" aria-label="环境变量 shell 格式">
              {(Object.keys(envShellLabels) as EnvShell[]).map((shell) => (
                <button
                  aria-pressed={envShell === shell}
                  className={envShell === shell ? "active" : ""}
                  key={shell}
                  onClick={() => setEnvShell(shell)}
                  type="button"
                >
                  {envShellLabels[shell]}
                </button>
              ))}
            </div>
            <button className="copy-button" onClick={() => void copyEnvCommand()} type="button">
              {copiedShell === envShell ? <Check size={15} /> : <Clipboard size={15} />}
              <span>{copiedShell === envShell ? "已复制" : "复制环境"}</span>
            </button>
          </div>
          <pre className="env-command">
            <code>{envCommand}</code>
          </pre>
        </div>
      ) : null}
      <div className="network-list">
        {props.requests.length === 0 ? <EmptyLine text="等待被测 CLI 的网络请求" /> : null}
        {props.requests.map((request) => (
          <article
            className={
              request.traceId && request.traceId === props.activeTraceId
                ? "network-row active"
                : "network-row"
            }
            key={request.id}
          >
            <div className="network-row-main">
              <span className={`method method-${request.method.toLowerCase()}`}>
                {request.method}
              </span>
              <strong title={request.url}>{request.url}</strong>
              <span className={`request-status status-${request.status}`}>
                {formatNetworkStatus(request)}
              </span>
            </div>
            <div className="network-row-meta">
              <time>{formatTime(request.startedAt)}</time>
              <span>{formatDuration(request.durationMs)}</span>
              <span>{formatBytes(request.requestBodyBytes)} up</span>
              <span>{formatBytes(request.responseBodyBytes)} down</span>
              {request.traceId ? (
                <button
                  className="trace-chip"
                  onClick={() => props.onTraceSelect(request.traceId ?? "")}
                  title="选择这个 Trace"
                  type="button"
                >
                  {request.traceId}
                </button>
              ) : (
                <code>未归因</code>
              )}
              {request.sessionId ? <code>{request.sessionId}</code> : null}
              {request.error ? <span className="network-row-error">{request.error}</span> : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
