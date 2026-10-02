import { useEffect, useRef, useState } from "react";
import type {
  NetworkCaptureStatus,
  NetworkRequestRecord,
  NetworkRequestsResponse,
  ObservationChangeEvent,
  ObservationHelloEvent,
  ObservationSourceErrorEvent,
} from "./shared";
import { mergeNetworkRequest } from "./network-model";

export interface ObservationEventState {
  connected: boolean;
  error: string | null;
  lastChangeAt?: string;
  watchedPathCount: number;
}

export function useObservationEvents(query: string, onChange: () => void): ObservationEventState {
  const onChangeRef = useRef(onChange);
  const [state, setState] = useState<ObservationEventState>({
    connected: false,
    error: null,
    watchedPathCount: 0,
  });

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    let closed = false;
    let refreshTimer: number | undefined;
    const events = new EventSource(`/api/observations/events${query}`);

    const scheduleRefresh = () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        if (!closed) onChangeRef.current();
      }, 180);
    };

    events.addEventListener("hello", (event) => {
      const parsed = parseMessageEvent<ObservationHelloEvent>(event);
      if (!parsed || closed) return;
      setState({
        connected: true,
        error: null,
        watchedPathCount: parsed.sources.length,
      });
    });
    events.addEventListener("change", (event) => {
      const parsed = parseMessageEvent<ObservationChangeEvent>(event);
      if (!parsed || closed) return;
      setState({
        connected: true,
        error: null,
        lastChangeAt: parsed.changedAt,
        watchedPathCount: parsed.sources.length,
      });
      scheduleRefresh();
    });
    events.addEventListener("source-error", (event) => {
      const parsed = parseMessageEvent<ObservationSourceErrorEvent>(event);
      if (!parsed || closed) return;
      setState((current) => ({
        ...current,
        connected: true,
        error: parsed.message,
      }));
    });
    events.addEventListener("open", () => {
      if (!closed) {
        setState((current) => ({ ...current, connected: true, error: null }));
      }
    });
    events.addEventListener("error", () => {
      if (!closed) {
        setState((current) => ({
          ...current,
          connected: false,
          error: "观测事件流已断开，正在等待浏览器重连。",
        }));
      }
    });

    return () => {
      closed = true;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      events.close();
    };
  }, [query]);

  return state;
}

export function useDelayedVisible(visible: boolean, delayMs: number): boolean {
  const [delayedVisible, setDelayedVisible] = useState(false);

  useEffect(() => {
    if (!visible) {
      setDelayedVisible(false);
      return;
    }

    const timer = window.setTimeout(() => setDelayedVisible(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, visible]);

  return delayedVisible;
}

export function useNetworkCapture(): {
  status: NetworkCaptureStatus | null;
  requests: NetworkRequestRecord[];
  error: string | null;
} {
  const [status, setStatus] = useState<NetworkCaptureStatus | null>(null);
  const [requests, setRequests] = useState<NetworkRequestRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let closed = false;

    async function loadInitialState() {
      try {
        const response = await fetchJson<NetworkRequestsResponse>(
          "/api/network/requests?limit=200",
        );
        if (closed) return;
        setStatus(response.status);
        setRequests(response.requests);
      } catch (fetchError) {
        if (!closed)
          setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
      }
    }

    void loadInitialState();
    const events = new EventSource("/api/network/events");
    events.addEventListener("status", (event) => {
      const parsed = parseMessageEvent<NetworkCaptureStatus>(event);
      if (parsed && !closed) setStatus(parsed);
    });
    events.addEventListener("snapshot", (event) => {
      const parsed = parseMessageEvent<NetworkRequestRecord[]>(event);
      if (parsed && !closed) setRequests(parsed);
    });
    events.addEventListener("request", (event) => {
      const parsed = parseMessageEvent<NetworkRequestRecord>(event);
      if (parsed && !closed) {
        setRequests((current) => mergeNetworkRequest(current, parsed));
      }
    });
    events.addEventListener("reset", () => {
      if (!closed) setRequests([]);
    });
    events.addEventListener("error", () => {
      if (!closed) setError("网络抓包事件流已断开，正在等待浏览器重连。");
    });
    events.addEventListener("open", () => {
      if (!closed) setError(null);
    });

    return () => {
      closed = true;
      events.close();
    };
  }, []);

  return { status, requests, error };
}

export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

function parseMessageEvent<T>(event: Event): T | null {
  const data = (event as MessageEvent<string>).data;
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}
