// ============================================================
// 阶段边的折叠与归约 - 显示图阶段层的唯一删边点
// ============================================================
// 从 create-workflow-graph-bounds.ts 拆出：折叠本身是一段自洽的纯图论（有序对折叠 +
// 强连通分量 + 在缩点上跑分析器的归约），而裁剪层其余部分讲的是引用完整性与上限。拆开后
// 这段逻辑可以单独读、单独钉住，也给 bounds 文件留出 max-lines 余量。

import {
  reduceOrdering,
  type ReducibleEdge,
  // 与 bounds 同一条理由：走 /projections 子路径而非根桶，根桶会把 typescript 编译器
  // 一起拖进浏览器包（作品集回放在浏览器里复用这条链路）。
} from "@lcode/dynamic-workflow/projections";

/** 折叠前的一条边：种类已经坍缩成「是不是回边」。 */
export interface RawEdge {
  from: string;
  to: string;
  back: boolean;
}

/**
 * 阶段边的折叠（交接边由分析器按同一算法归约好了送来，这里不再碰）：
 *
 * 一、同一有序对折叠成一条（首见序），`back` 当且仅当折叠前的**全部**边都是回边——存在
 * 任何一条前向事实就按前向处理，宁可让排秩多一条约束，不能少一条；自环丢弃。
 *
 * 二、归约跑在**缩点**上，而不是原图上。取前向边（回边不算）的强连通分量：同一分量内的边
 * 无条件留下，跨分量的边按 (分量对, kind) 去重后喂给分析器的贪心不可约归约（前向边同一
 * kind、回边作 carry（`carryOf: "seq"`），它就退化成无类型归约），再按存活的分量对展开
 * 回原边。输出保持输入序。
 *
 * 把原图直接喂给归约是错的：一条见证路径可以绕环走回
 * 来。两组互不相干的 if/else 复用同一对阶段名时，商图里 甲→乙 与 乙→甲 都是普通分支边，
 * 归约据此把 选择→甲 判成被 选择→乙→甲 蕴含而删掉，画面就变成「条件分支总是走乙，甲是乙
 * 的岔路」——一句假话。穿过与端点同环的节点的路径对「控制能不能到那儿」不作任何断言，所以
 * 见证只在缩点这张 DAG 上才成立。
 */
export function foldPhaseEdges(raw: readonly RawEdge[]): RawEdge[] {
  const folded = foldPairs(raw);
  const componentOf = componentsOf(folded);
  const component = (id: string): string => componentOf.get(id) ?? id;
  const keyOf = (from: string, to: string, back: boolean): string => `${from} ${to} ${back}`;

  // 跨分量的边按 (分量对, kind) 去重，首见序；同分量的边根本不进归约——它在缩点里是自环，
  // 对 DAG 上的可达关系什么都没说。
  const order: string[] = [];
  const byKey = new Map<string, ReducibleEdge>();
  for (const edge of folded) {
    const from = component(edge.from);
    const to = component(edge.to);
    if (from === to) continue;
    const key = keyOf(from, to, edge.back);
    if (byKey.has(key)) continue;
    order.push(key);
    byKey.set(
      key,
      edge.back ? { carryOf: "seq", from, kind: "carry", to } : { from, kind: "seq", to },
    );
  }
  const condensed = order.map((key) => byKey.get(key) as ReducibleEdge);
  const kept = new Set(
    reduceOrdering(condensed).map((edge) => keyOf(edge.from, edge.to, edge.kind === "carry")),
  );
  return folded.filter((edge) => {
    const from = component(edge.from);
    const to = component(edge.to);
    return from === to || kept.has(keyOf(from, to, edge.back));
  });
}

/** 同一有序对折叠成一条，首见序；`back` 是折叠成员的合取；自环丢弃。 */
function foldPairs(raw: readonly RawEdge[]): RawEdge[] {
  const order: string[] = [];
  const byKey = new Map<string, RawEdge>();
  for (const edge of raw) {
    if (edge.from === edge.to) continue;
    const key = `${edge.from} ${edge.to}`;
    const seen = byKey.get(key);
    if (seen === undefined) {
      order.push(key);
      byKey.set(key, { ...edge });
    } else {
      seen.back = seen.back && edge.back;
    }
  }
  return order.map((key) => byKey.get(key) as RawEdge);
}

/**
 * 每个节点 → 它所在强连通分量的代表（分量里首次出现的节点）。只看前向边：回边说的是
 * 「下一轮」，把它算进分量会让整个循环体缩成一个点，循环体内部真正冗余的边就再也删不掉。
 *
 * 用互相可达而不是 Tarjan：阶段图上界 32 个节点（`CREATE_WORKFLOW_GRAPH_MAX_PHASES`），
 * 成本无关紧要，而「a 到 b 且 b 到 a」是分量定义本身，读起来不需要再证一遍。
 */
function componentsOf(folded: readonly RawEdge[]): Map<string, string> {
  const nodes: string[] = [];
  const seen = new Set<string>();
  const next = new Map<string, string[]>();
  for (const edge of folded) {
    for (const id of [edge.from, edge.to]) {
      if (seen.has(id)) continue;
      seen.add(id);
      nodes.push(id);
    }
    if (edge.back) continue;
    const list = next.get(edge.from);
    if (list === undefined) next.set(edge.from, [edge.to]);
    else list.push(edge.to);
  }

  const reach = new Map<string, Set<string>>();
  for (const start of nodes) {
    const reached = new Set<string>();
    const stack = [...(next.get(start) ?? [])];
    while (stack.length > 0) {
      const node = stack.pop() as string;
      if (reached.has(node)) continue;
      reached.add(node);
      stack.push(...(next.get(node) ?? []));
    }
    reach.set(start, reached);
  }

  const componentOf = new Map<string, string>();
  for (const node of nodes) {
    if (componentOf.has(node)) continue;
    componentOf.set(node, node);
    for (const other of reach.get(node) ?? []) {
      if (componentOf.has(other)) continue;
      if (reach.get(other)?.has(node) === true) componentOf.set(other, node);
    }
  }
  return componentOf;
}
