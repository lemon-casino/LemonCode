import armsRum from "@arms/rum-electron";
import type { LCodeMcpTelemetryEvent } from "@lcode/shared";

interface DesktopMcpTelemetryContext {
  appVersion: string;
  armsEnv: string;
  deviceMid: string;
}

let context: DesktopMcpTelemetryContext | undefined;

export function configureDesktopMcpTelemetry(next: DesktopMcpTelemetryContext): void {
  context = next;
}

export function reportMcpTelemetryToArms(
  event: LCodeMcpTelemetryEvent,
  runtimeSurface: "local" | "remote",
): void {
  // 旧 CLI 的内存通知仍允许协议解析，但不能再生成已废弃的 ARMS 事件。
  if (!context || event.kind === "memory") return;
  const mapped = mapMcpTelemetryEvent(event);
  try {
    armsRum.sendCustom({
      group: mapped.group,
      name: mapped.name,
      properties: stringifyProperties({
        app_version: context.appVersion,
        arms_env: context.armsEnv,
        device_mid: context.deviceMid,
        event_name: mapped.name,
        metric_value: mapped.value,
        runtime_surface: runtimeSurface,
        platform: normalizePlatform(event.platform),
        arch: event.arch,
        occurred_at: event.occurredAt,
        ...mapped.properties,
      }),
      type: "custom",
      value: mapped.value,
    });
  } catch (error) {
    console.warn("[mcp-telemetry] sendCustom failed:", mapped.name, error);
  }
}

function mapMcpTelemetryEvent(event: Exclude<LCodeMcpTelemetryEvent, { kind: "memory" }>): {
  group: "resource" | "stability";
  name: string;
  properties: Record<string, string | number | boolean | undefined | null>;
  value: number;
} {
  switch (event.kind) {
    case "process_start":
      return {
        group: "stability",
        name: "perf_mcp_process_start",
        properties: processProperties(event),
        value: 1,
      };
    case "process_crash":
      return {
        group: "stability",
        name: "perf_mcp_process_crash",
        properties: {
          ...processProperties(event),
          affected_session_count: event.affectedSessionCount,
          exit_code: event.exitCode,
          signal: event.signal,
          uptime_ms: event.uptimeMs,
        },
        value: 1,
      };
    case "session_startup":
      return {
        group: "stability",
        name: "perf_mcp_session_startup",
        properties: {
          session_id: event.sessionId,
          configured_count: event.configuredCount,
          connected_count: event.connectedCount,
          process_count: event.processCount,
          failed_count: event.failedCount,
        },
        value: event.processCount,
      };
  }
}

function processProperties(
  event: Extract<LCodeMcpTelemetryEvent, { kind: "process_start" | "process_crash" }>,
): Record<string, string> {
  return {
    mcp_id: event.mcpId,
    mcp_instance_id: event.mcpInstanceId,
    mcp_isolation: event.mcpIsolation,
    mcp_source: event.mcpSource,
  };
}

function stringifyProperties(
  properties: Record<string, string | number | boolean | undefined | null>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(properties)
      .filter((entry): entry is [string, string | number | boolean] => entry[1] != null)
      .map(([key, value]) => [key, String(value)]),
  );
}

function normalizePlatform(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}
