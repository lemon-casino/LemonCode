// 引擎事件的 journal sequence 截取层。独立成模块而不是留在 launch.ts 里：那边的职责是「装配并启动一个 run」，而这里是
// 「把 appendEvent 分配到的号截给紧随其后的 emit」——两件事各自完整，且这一件只有一个消费者。
import type { JournalStorePort, RunEvent, StoredEvent } from "@lcode/dynamic-workflow";

/**
 * 包一层 journal，只为把 `appendEvent` 分配到的 sequence 截下来供紧随其后的 emit 使用。
 *
 * 前提（由引擎的 `record()` 保证，且被测试钉住）：每条事件都是「appendEvent 后同步紧接着
 * emit」，一一对应。所以"最后一次 append 的 sequence"就是"当前正在 emit 的那条"的 sequence。
 * 序号保留既有最后一次 append 的读取方式。源时间按 append 入参的引用配对：journal 可以克隆事件，
 * 对照 StoredEvent.event 会漏掉真实时刻；不是刚写入的那条事件则不提供时间，不能用当前时间补齐。
 */
export function createJournalSequenceCapture(journal: JournalStorePort): {
  journal: JournalStorePort;
  sequenceOf: (event: RunEvent) => number;
  timeOf: (event: RunEvent) => number | undefined;
} {
  let lastStored: StoredEvent | undefined;
  let appendedEvent: RunEvent | undefined;
  // 逐方法显式转发而不是 `{...journal, appendEvent}`：两个实现都是 class，展开只拷贝自有属性，
  // 原型上的方法会全部丢掉（引擎随后调 getRun 就会 TypeError）。转发面**只有引擎端口**：
  // 孤儿收敛与枚举的窄查询刻意不在其中——它们发生在 service 侧、直接对 deps.journal，不经这一层。
  const wrapped: JournalStorePort = {
    createRun: (record) => journal.createRun(record),
    getRun: (runId) => journal.getRun(runId),
    updateRunStatus: (runId, status, settlement) =>
      journal.updateRunStatus(runId, status, settlement),
    updateRunUsage: (runId, spentTokens) => journal.updateRunUsage(runId, spentTokens),
    putActor: (record) => journal.putActor(record),
    getActor: (runId, siteId, ordinal) => journal.getActor(runId, siteId, ordinal),
    listActors: (runId) => journal.listActors(runId),
    putNode: (record) => journal.putNode(record),
    getNode: (runId, siteId, ordinal) => journal.getNode(runId, siteId, ordinal),
    listNodes: (runId) => journal.listNodes(runId),
    appendEvent: (runId, event) => {
      const stored = journal.appendEvent(runId, event);
      lastStored = stored;
      appendedEvent = event;
      return stored;
    },
    listEvents: (runId, opts) => journal.listEvents(runId, opts),
  };
  return {
    journal: wrapped,
    sequenceOf: (event) =>
      lastStored?.event === event ? lastStored.sequence : (lastStored?.sequence ?? 0),
    // journal 可克隆事件；以 append 的原对象配对，不能用克隆对象或当前时间猜测源时刻。
    timeOf: (event) => appendedEvent === event ? lastStored?.timeCreated : undefined,
  };
}
