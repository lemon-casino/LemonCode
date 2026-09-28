import { LOCAL_TTFT_TTL_MS } from "@lcode/shared";

const MAX_OBSERVATIONS = 1024;
const MAX_FACTS_PER_OBSERVATION = 512;

/** 只维护出口去重身份；满载拒绝新明细，不逐 key 淘汰正在观察输入的根身份。 */
export class LocalTtftExportDedupe {
  private readonly observations = new Map<string, { start: number; facts: Set<string> }>();
  constructor(private readonly now = Date.now) {}
  admit(
    renderer: string,
    observation: string,
    start: number,
  ): ((factId: string) => boolean) | undefined {
    const now = this.now();
    // 与 Renderer 的观察保留窗口一致；窗口外的重传不能重新创建 Histogram 样本。
    if (now - start > LOCAL_TTFT_TTL_MS) return;
    for (const [id, entry] of this.observations)
      if (now - entry.start > LOCAL_TTFT_TTL_MS) this.observations.delete(id);
    const key = `${renderer}:${observation}`;
    let entry = this.observations.get(key);
    if (!entry) {
      if (this.observations.size >= MAX_OBSERVATIONS) return;
      entry = { start, facts: new Set() };
      this.observations.set(key, entry);
    }
    const facts = entry.facts;
    return (factId) => {
      if (facts.has(factId) || facts.size >= MAX_FACTS_PER_OBSERVATION) return false;
      facts.add(factId);
      return true;
    };
  }
}
