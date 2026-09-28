import type { PrintPageToPdfResult } from "@lcode/shared";
import { PlatformChannels } from "@lcode/shared";
import { ipcMain } from "electron";

/** 同一 webContents 的打印请求串行化，防止重复触发 Chromium 打印管线 */
const inFlightSenderIds = new Set<number>();

export function registerDesktopPrintToPdfIpcHandler(logger: {
  warn: (...args: unknown[]) => void;
}) {
  ipcMain.handle(PlatformChannels.PrintToPdf, async (event): Promise<PrintPageToPdfResult> => {
    const senderId = event.sender.id;
    if (inFlightSenderIds.has(senderId)) {
      return { success: false, error: "print_in_progress" };
    }
    inFlightSenderIds.add(senderId);
    try {
      const buffer = await event.sender.printToPDF({
        printBackground: true,
        // 页面尺寸完全由 renderer 注入的 @page CSS 决定，main 端不接受 renderer 参数
        preferCSSPageSize: true,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
      });
      // Buffer 可能是池化视图，切出独立 ArrayBuffer 再走 structured clone
      const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      return { success: true, data };
    } catch (error) {
      logger.warn(
        `[print-to-pdf] 导出失败 error=${error instanceof Error ? error.message : String(error)}`,
      );
      return { success: false, error: "print_failed" };
    } finally {
      inFlightSenderIds.delete(senderId);
    }
  });
}
