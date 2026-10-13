/** 每把冷却 Key 只有一个堆节点；并发迟到结果更新节点，不能积累过期 timer/记录。 */
export class ApiKeyCooldownQueue {
  private readonly heap: Array<{ index: number; until: number }> = [];
  private readonly positions = new Map<number, number>();
  get size(): number {
    return this.heap.length;
  }
  get nextDeadline(): number | undefined {
    return this.heap[0]?.until;
  }
  extend(index: number, until: number): void {
    const position = this.positions.get(index);
    if (position !== undefined) {
      this.heap[position]!.until = Math.max(this.heap[position]!.until, until);
      this.down(position);
      return;
    }
    this.positions.set(index, this.heap.length);
    this.heap.push({ index, until });
    this.up(this.heap.length - 1);
  }
  popDue(now: number): number | undefined {
    const first = this.heap[0];
    if (!first || first.until > now) return undefined;
    const last = this.heap.pop()!;
    this.positions.delete(first.index);
    if (this.heap.length) {
      this.heap[0] = last;
      this.positions.set(last.index, 0);
      this.down(0);
    }
    return first.index;
  }
  clear(): void {
    this.heap.length = 0;
    this.positions.clear();
  }
  private up(position: number): void {
    while (position > 0) {
      const parent = (position - 1) >> 1;
      if (this.heap[parent]!.until <= this.heap[position]!.until) break;
      this.swap(parent, position);
      position = parent;
    }
  }
  private down(position: number): void {
    for (;;) {
      const left = position * 2 + 1,
        right = left + 1;
      let next = position;
      if (left < this.heap.length && this.heap[left]!.until < this.heap[next]!.until) next = left;
      if (right < this.heap.length && this.heap[right]!.until < this.heap[next]!.until)
        next = right;
      if (next === position) return;
      this.swap(position, next);
      position = next;
    }
  }
  private swap(first: number, second: number): void {
    [this.heap[first], this.heap[second]] = [this.heap[second]!, this.heap[first]!];
    this.positions.set(this.heap[first]!.index, first);
    this.positions.set(this.heap[second]!.index, second);
  }
}
