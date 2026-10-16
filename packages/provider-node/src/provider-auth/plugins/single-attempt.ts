/** 原 worker operation 的物理派发许可；鉴权刷新不借用模型许可，失败不恢复。 */
export class PluginSingleAttempt {
  constructor(private readonly channel?: string) {}
  private used = false;
  violated = false;
  private firstFailure?: { status: number; headers: Headers };
  claim(method: string, path: string): boolean {
    if (method.toUpperCase() !== "POST") return false;
    // Cursor 已打开的同一 Run 用 append 递交工具结果，它不是第二个模型 Run。
    if (this.channel === "cursor" && path === "/aiserver.v1.BidiService/BidiAppend" && this.used)
      return false;
    if (this.used) {
      this.violated = true;
      throw Object.assign(new Error("Routing single attempt exhausted"), {
        code: "routing-single-attempt-exhausted",
      });
    }
    this.used = true;
    return true;
  }
  observe(status: number, headers: Headers): void {
    if (status >= 400 && !this.firstFailure)
      this.firstFailure = { status, headers: new Headers(headers) };
  }
  preserve(response: Response): Response {
    if (!this.firstFailure || response.status < 400) return response;
    const headers = new Headers(response.headers);
    for (const key of ["retry-after", "x-ratelimit-scope", "ratelimit-scope"]) {
      const value = this.firstFailure.headers.get(key);
      if (value !== null) headers.set(key, value);
    }
    return new Response(response.body, { status: this.firstFailure.status, headers });
  }
  failure(): Response {
    const failure = this.firstFailure;
    if (!failure)
      throw Object.assign(new Error("Routing dispatch outcome is unconfirmed"), {
        code: "routing-single-attempt-exhausted",
      });
    // 插件可能已消费首个 body；保留原 HTTP/Retry-After 事实，不能返回后续未派发重试的伪响应。
    const headers = new Headers(failure.headers);
    for (const key of ["content-encoding", "content-length", "transfer-encoding"])
      headers.delete(key);
    headers.set("content-type", "application/json");
    return new Response(
      JSON.stringify({
        error: { message: "Provider request failed", code: "routing-single-attempt-exhausted" },
      }),
      { status: failure.status, headers },
    );
  }
}
