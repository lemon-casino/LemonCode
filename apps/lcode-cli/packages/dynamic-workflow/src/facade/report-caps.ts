/**
 * `report` 的上限常量。
 *
 * 与 `world-read-caps.ts` 分成两个模块，是因为两者的**执行侧不同**：world-read 的上限由
 * driver 执行（只有它能"不生产"——让 ripgrep 在 2000 条上停手），report 的上限由**引擎核心**
 * 执行（report 不过 driver，它在核心里落 journal 就结束了）。同一个模块会让读者以为它们由
 * 同一侧强制；数字都是契约这一点则两处相同。
 *
 * 溢出的策略是**失败整个 run**（`ReportCapExceeded`），而不是像 world-read 那样拒绝节点。
 * 这不是严重程度的判断而是**拒绝通道**的事实：`report` 返回 `void`，脚本没有地方 `catch`。
 * 也正因为脚本作者写不出恢复路径，这两个数字必须宽到一份讲道理的脚本永远碰不到。
 */

/** 每个 run 的报告条数与单条序列化字节数上限。数字即契约（见本模块顶部）。 */
export const REPORT_CAPS = {
  /** 一个 run 内 `report` 的最大条数。 */
  maxItemsPerRun: 256,
  /** 单条 item 序列化后的最大字节数。 */
  maxItemSerializedBytes: 32 * 1024,
} as const;
