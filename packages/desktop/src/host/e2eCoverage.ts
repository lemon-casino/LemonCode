import { mkdirSync } from "node:fs";
import { takeCoverage } from "node:v8";

export function flushHostE2ECoverage(onError?: (error: unknown) => void): boolean {
  if (process.env.LCODE_E2E_COVERAGE !== "1" || !process.env.NODE_V8_COVERAGE?.trim()) {
    return false;
  }
  try {
    mkdirSync(process.env.NODE_V8_COVERAGE, { recursive: true });
    // host 的退出由 main 调度，异常或强制回收时不保证 Node 自动写盘；
    // 在资源释放完成后主动 flush，确保本进程 isolate 的 V8 counter 落盘。
    takeCoverage();
    return true;
  } catch (error) {
    onError?.(error);
    return false;
  }
}
