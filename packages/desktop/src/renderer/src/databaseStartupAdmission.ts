import { databaseStartupPortPayloadSchema, type DatabaseStartupState } from "@lcode/shared";

/** 页面只做同代准入；ready(A) 不能与端口(B) 拼成一次完成事实。 */
export class DatabaseStartupAdmission {
  state: DatabaseStartupState | null = null;
  private pending?: { startupId: string; port: MessagePort };

  acceptState(state: DatabaseStartupState): boolean {
    if (this.state?.startupId === state.startupId && this.state.sequence >= state.sequence)
      return false;
    this.state = state;
    return true;
  }

  acceptPort(payload: unknown, port: MessagePort): void {
    const parsed = databaseStartupPortPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      port.close();
      return;
    }
    if (this.pending?.port !== port) this.pending?.port.close();
    this.pending = { startupId: parsed.data.databaseStartupId, port };
  }

  takeReadyPort(): MessagePort | undefined {
    if (this.state?.phase !== "ready" || this.pending?.startupId !== this.state.startupId) return;
    const port = this.pending.port;
    this.pending = undefined;
    return port;
  }
}
