interface Entry {
  id: string;
  at: number;
}
/** 时间只驱动派生索引失效；不使用 timer，不参与请求 admission。 */
export class RoutingDeadlineIndex {
  private readonly heap: Entry[] = [];
  private readonly positions = new Map<string, number>();
  set(id: string, at: number): void {
    const prior = this.positions.get(id);
    if (prior !== undefined) this.remove(prior);
    if (!Number.isFinite(at)) return;
    const index = this.heap.length;
    this.heap.push({ id, at });
    this.positions.set(id, index);
    this.up(index);
  }
  get nextAt(): number {
    return this.heap[0]?.at ?? Infinity;
  }
  takeDue(now: number, limit = Infinity): string[] {
    const result: string[] = [];
    while (result.length < limit && this.heap[0] && this.heap[0].at <= now) {
      result.push(this.heap[0].id);
      this.remove(0);
    }
    return result;
  }
  private swap(a: number, b: number): void {
    const value = this.heap[a]!;
    this.heap[a] = this.heap[b]!;
    this.heap[b] = value;
    this.positions.set(this.heap[a]!.id, a);
    this.positions.set(this.heap[b]!.id, b);
  }
  private up(index: number): number {
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (this.heap[parent]!.at <= this.heap[index]!.at) break;
      this.swap(index, parent);
      index = parent;
    }
    return index;
  }
  private down(index: number): void {
    for (;;) {
      const left = index * 2 + 1,
        right = left + 1;
      let next = index;
      if (left < this.heap.length && this.heap[left]!.at < this.heap[next]!.at) next = left;
      if (right < this.heap.length && this.heap[right]!.at < this.heap[next]!.at) next = right;
      if (next === index) return;
      this.swap(index, next);
      index = next;
    }
  }
  private remove(index: number): void {
    const removed = this.heap[index]!,
      last = this.heap.pop()!;
    this.positions.delete(removed.id);
    if (index >= this.heap.length) return;
    this.heap[index] = last;
    this.positions.set(last.id, index);
    this.down(this.up(index));
  }
}
