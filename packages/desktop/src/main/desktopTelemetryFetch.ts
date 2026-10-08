interface DesktopTelemetryFetchSource {
  fetch: (input: string | Request, init?: RequestInit) => Promise<Response>;
}

export function createDesktopTelemetryFetch(source: DesktopTelemetryFetchSource): typeof fetch {
  // Electron net.fetch 不接收 URL 对象；适配标准 fetch 输入，同时保留 Request 身份和参数。
  return (input, init) => source.fetch(input instanceof URL ? input.toString() : input, init);
}
