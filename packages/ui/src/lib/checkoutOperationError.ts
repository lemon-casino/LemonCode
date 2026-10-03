import { getErrorMessage } from "./errorMessage.js";

export function getCheckoutOperationErrorMessage(
  error: unknown,
  directoryBusyMessage: string,
): string {
  const message = getErrorMessage(error);
  // 远程 RPC 可能只保留 message；仅识别协调器明确的占用错误，不把其它失败伪装成等待。
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return code === "LCODE_CHECKOUT_BUSY" ||
    message === "Checkout is busy; wait for its current writer to finish"
    ? directoryBusyMessage
    : message;
}
