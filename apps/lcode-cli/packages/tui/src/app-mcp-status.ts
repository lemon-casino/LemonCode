import { useEffect, useState } from "react";
import type { McpSidebarState } from "./app-model.js";
import type { TuiListMcpServers } from "./types.js";

const MCP_STATUS_REFRESH_INTERVAL_MS = 5_000;
const MCP_STATUS_RETRY_INTERVAL_MS = 10_000;

export function useMcpSidebarStatus(
  listMcpServers: TuiListMcpServers | undefined,
): McpSidebarState {
  const [state, setState] = useState<McpSidebarState>(() => ({
    loading: listMcpServers !== undefined,
    servers: {},
  }));

  useEffect(() => {
    if (!listMcpServers) {
      setState({ loading: false, servers: {} });
      return;
    }
    const loadMcpServers = listMcpServers;

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function scheduleRefresh(delayMs: number) {
      timer = setTimeout(() => {
        void refresh();
      }, delayMs);
    }

    async function refresh() {
      setState((current) => ({
        ...current,
        loading: Object.keys(current.servers).length === 0,
      }));

      try {
        const servers = await loadMcpServers();
        if (disposed) return;
        setState({ loading: false, servers });
        scheduleRefresh(MCP_STATUS_REFRESH_INTERVAL_MS);
      } catch (error) {
        if (disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        setState((current) => ({ ...current, error: message, loading: false }));
        scheduleRefresh(MCP_STATUS_RETRY_INTERVAL_MS);
      }
    }

    void refresh();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [listMcpServers]);

  return state;
}
