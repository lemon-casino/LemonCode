/**
 * REPL cell 的同步错误由 NodeReplSession 兜底，但 fire-and-forget 的异步错误
 * （如未 await 的 tab.* 调用在 turn 中断时被 reject）会按 Node 默认策略击穿整个 server
 * 进程。子进程一死，会话内 Browser Use 从此不可用。这里把异步错误降级为 stderr 日志：
 * runtime 状态保留、协议 stdout 不受影响。
 *
 * 父进程退出后 stderr 会报 EPIPE。旧 handler 又把 EPIPE 堆栈写回同一条
 * stderr，形成 EPIPE -> uncaughtException -> stderr.write -> EPIPE 的无限循环。
 * 输出管道关闭表示 MCP client 已不可达，必须直接进入 shutdown，不能继续写诊断。
 */
export declare function installNodeReplProcessGuards(input: {
    onOutputClosed: (error: Error) => void;
    process: Pick<NodeJS.Process, "on">;
    writeStderr: (text: string) => void;
}): void;
export declare function installNodeReplShutdownTriggers(input: {
    process: Pick<NodeJS.Process, "once">;
    shutdown: () => void;
    stdin: Pick<NodeJS.ReadStream, "once">;
}): void;
export declare function isDirectMcpEntrypoint(importMetaUrl: string, argvPath: string | undefined): Promise<boolean>;
//# sourceMappingURL=process-lifecycle.d.ts.map