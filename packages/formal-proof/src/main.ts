import * as d3 from "d3";
import {
  buildTraceTree,
  collectStats,
  contextKey,
  contextLabel,
  decisionLabel,
  flatten,
  profiles,
  type Candidate,
  type Decision,
  type DecisionKind,
  type NodeKind,
  type ProductContext,
  type TraceNode,
} from "./model.js";
import "./styles.css";

type ReviewStatus = "accepted" | "undefined" | "invalid" | "ignored" | "bug";

interface RenderBudget {
  remaining: number;
}

interface GraphNodeDatum {
  readonly id: string;
  readonly kind: NodeKind;
  readonly representative: TraceNode;
  readonly members: TraceNode[];
  readonly title: string;
  readonly subtitle: string;
  readonly detail: string;
  readonly context: ProductContext;
  readonly candidate?: Candidate;
  readonly decision?: Decision;
  readonly caseId?: string;
  readonly e2e?: string;
  readonly column: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface GraphEdgeDatum {
  readonly id: string;
  readonly source: GraphNodeDatum;
  readonly target: GraphNodeDatum;
  readonly decision?: Decision;
}

interface StateSpaceGraph {
  readonly nodes: GraphNodeDatum[];
  readonly edges: GraphEdgeDatum[];
  readonly columns: number[];
  readonly width: number;
  readonly height: number;
}

interface TreeViewState {
  root: TraceNode;
  renderRoot: TraceNode;
  nodes: TraceNode[];
  selectedId: string;
  activeRule: string;
  activeDecision: DecisionKind | "all";
  review: Record<string, ReviewStatus>;
}

const reviewKey = "lcode.conversation-state-space.review.v1";
const statusOptions: ReviewStatus[] = ["accepted", "undefined", "invalid", "ignored", "bug"];
const numberFormat = new Intl.NumberFormat("zh-CN");
const app = mustQuery<HTMLDivElement>("#app");

let zoomBehavior: d3.ZoomBehavior<SVGSVGElement, unknown> | null = null;
let fitTransform: d3.ZoomTransform | null = null;
let defaultTransform: d3.ZoomTransform | null = null;
let graphNodeIndex = new Map<string, GraphNodeDatum>();
let viewState: TreeViewState;

app.innerHTML = `
  <main class="app">
    <aside class="side-panel panel">
      <div class="brand">
        <h1>Conversation State Space</h1>
        <p class="subtitle">
          从 GUI 用户视角枚举 compact、fork、goal、消息队列和 query 编辑的组合。每个候选动作先进入笛卡尔积，再由产品 guard 剪枝；未定义路径会保留下来供人工 review，并最终导出为 E2E case。
        </p>
      </div>

      <section class="side-section">
        <div class="panel-header"><h2>参数枚举</h2></div>
        <div class="panel-body controls">
          <div class="control">
            <label for="profileSelect">初始上下文</label>
            <select id="profileSelect">
              ${profiles.map((profile) => `<option value="${profile.id}">${profile.label}</option>`).join("")}
            </select>
          </div>
          <div class="control">
            <label for="roundSelect">递归轮次</label>
            <select id="roundSelect">
              <option value="1">1 轮：只看下一步</option>
              <option value="2">2 轮：动作后继续枚举</option>
              <option value="3" selected>3 轮：推荐</option>
              <option value="4">4 轮：更大状态空间</option>
            </select>
          </div>
          <div class="control">
            <label for="budgetSelect">画布渲染预算</label>
            <select id="budgetSelect">
              <option value="350">350 节点</option>
              <option value="800" selected>800 节点</option>
              <option value="1600">1,600 节点</option>
              <option value="3200">3,200 节点</option>
            </select>
          </div>
          <div class="control">
            <label for="decisionSelect">结果过滤</label>
            <select id="decisionSelect">
              <option value="all">全部结果</option>
              <option value="reject">只看 reject 剪枝</option>
              <option value="undefined">只看 undefined</option>
              <option value="enqueue">只看 queue</option>
              <option value="allow">只看 allow</option>
              <option value="system">只看 system</option>
            </select>
          </div>
        </div>
      </section>

      <section class="side-section">
        <div class="panel-header"><h2>语义统计</h2></div>
        <div class="metrics" aria-label="状态空间统计">
          <div class="metric"><strong id="metricNodes">0</strong><span>语义节点</span></div>
          <div class="metric"><strong id="metricCases">0</strong><span>Review cases</span></div>
          <div class="metric"><strong id="metricRejects">0</strong><span>Reject 剪枝</span></div>
          <div class="metric"><strong id="metricUndefined">0</strong><span>Undefined</span></div>
          <div class="metric"><strong id="metricQueue">0</strong><span>Queue</span></div>
          <div class="metric"><strong id="metricRendered">0</strong><span>图节点</span></div>
        </div>
      </section>

      <section class="side-section rule-section">
        <div class="panel-header"><h2>规则命中</h2></div>
        <div class="panel-body rule-body">
          <p class="hint">点击规则会高亮对应语义节点。reject 是产品规则剪枝，undefined 是还没定义的产品逻辑。</p>
          <div id="ruleList" class="rule-list"></div>
        </div>
      </section>
    </aside>

    <section class="canvas-panel panel">
      <div class="toolbar">
        <div>
          <strong>State-Space DAG</strong>
          <p class="hint">横向按 State、Action、Guard、Effect、Case 展开；等价节点会合并并显示命中次数。拖拽移动，滚轮缩放，点击节点查看详情。</p>
        </div>
        <div class="toolbar-actions">
          <button id="zoomOut" class="toolbar-button" type="button" aria-label="缩小">-</button>
          <button id="zoomIn" class="toolbar-button" type="button" aria-label="放大">+</button>
          <button id="fitTree" class="toolbar-button" type="button">适配</button>
          <button id="resetTree" class="toolbar-button" type="button">重置</button>
          <button id="exportCases" class="toolbar-button" type="button">导出 JSON</button>
        </div>
      </div>
      <div class="graph-shell">
        <svg id="tree" role="img" aria-label="Conversation behavior state-space DAG"></svg>
        <aside id="nodePopover" class="node-popover" hidden>
          <div class="popover-header">
            <div>
              <b id="detailTitle">-</b>
              <span id="detailKind">-</span>
            </div>
            <button id="closeDetail" class="icon-button" type="button" aria-label="关闭节点详情">x</button>
          </div>
          <div class="popover-body detail-grid">
            <div class="detail-row"><b>上下文</b><code id="detailContext">-</code></div>
            <div class="detail-row"><b>产品语义</b><span id="detailText">-</span></div>
            <div class="detail-row"><b>E2E 断言</b><span id="detailE2e">-</span></div>
            <div class="detail-row">
              <b>Review</b>
              <div id="reviewButtons" class="review-buttons"></div>
            </div>
            <div class="detail-row"><b>代表路径</b><ul id="detailPath" class="path-list"></ul></div>
          </div>
        </aside>
      </div>
    </section>
  </main>
`;

const elements = {
  profileSelect: mustQuery<HTMLSelectElement>("#profileSelect"),
  roundSelect: mustQuery<HTMLSelectElement>("#roundSelect"),
  budgetSelect: mustQuery<HTMLSelectElement>("#budgetSelect"),
  decisionSelect: mustQuery<HTMLSelectElement>("#decisionSelect"),
  metricNodes: mustQuery<HTMLElement>("#metricNodes"),
  metricCases: mustQuery<HTMLElement>("#metricCases"),
  metricRejects: mustQuery<HTMLElement>("#metricRejects"),
  metricUndefined: mustQuery<HTMLElement>("#metricUndefined"),
  metricQueue: mustQuery<HTMLElement>("#metricQueue"),
  metricRendered: mustQuery<HTMLElement>("#metricRendered"),
  ruleList: mustQuery<HTMLElement>("#ruleList"),
  tree: mustQuery<SVGSVGElement>("#tree"),
  nodePopover: mustQuery<HTMLElement>("#nodePopover"),
  detailTitle: mustQuery<HTMLElement>("#detailTitle"),
  detailKind: mustQuery<HTMLElement>("#detailKind"),
  detailContext: mustQuery<HTMLElement>("#detailContext"),
  detailText: mustQuery<HTMLElement>("#detailText"),
  detailE2e: mustQuery<HTMLElement>("#detailE2e"),
  detailPath: mustQuery<HTMLElement>("#detailPath"),
  reviewButtons: mustQuery<HTMLElement>("#reviewButtons"),
  closeDetail: mustQuery<HTMLButtonElement>("#closeDetail"),
  zoomIn: mustQuery<HTMLButtonElement>("#zoomIn"),
  zoomOut: mustQuery<HTMLButtonElement>("#zoomOut"),
  fitTree: mustQuery<HTMLButtonElement>("#fitTree"),
  resetTree: mustQuery<HTMLButtonElement>("#resetTree"),
  exportCases: mustQuery<HTMLButtonElement>("#exportCases"),
};

const initialRoot = rebuildRoot();
viewState = {
  root: initialRoot,
  renderRoot: initialRoot,
  nodes: [],
  selectedId: "",
  activeRule: "all",
  activeDecision: "all",
  review: readReview(),
};

renderReviewButtons();
renderAll();

for (const select of [elements.profileSelect, elements.roundSelect, elements.budgetSelect]) {
  select.addEventListener("change", () => {
    viewState.selectedId = "";
    viewState.root = rebuildRoot();
    renderAll();
  });
}

elements.decisionSelect.addEventListener("change", () => {
  viewState.activeDecision = elements.decisionSelect.value as DecisionKind | "all";
  renderAll();
});
elements.zoomIn.addEventListener("click", () => zoomBy(1.25));
elements.zoomOut.addEventListener("click", () => zoomBy(0.8));
elements.fitTree.addEventListener("click", () => applyTransform(fitTransform));
elements.resetTree.addEventListener("click", () => applyTransform(defaultTransform));
elements.exportCases.addEventListener("click", exportCases);
elements.closeDetail.addEventListener("click", () => {
  viewState.selectedId = "";
  updateSelectedNodeClasses();
  renderDetail();
});

function renderAll(): void {
  const budget = { remaining: Number(elements.budgetSelect.value) };
  viewState.renderRoot = cloneForRender(viewState.root, budget);
  viewState.nodes = flatten(viewState.root);
  renderMetrics();
  renderRules();
  renderGraph();
  renderDetail(selectedGraphNode());
}

function rebuildRoot(): TraceNode {
  const profile = profiles.find((item) => item.id === elements.profileSelect.value) ?? profiles[0];
  if (!profile) {
    throw new Error("No model profiles defined");
  }
  return buildTraceTree(profile.context, Number(elements.roundSelect.value));
}

function renderMetrics(): void {
  const stats = collectStats(viewState.root);
  elements.metricNodes.textContent = numberFormat.format(stats.nodes);
  elements.metricCases.textContent = numberFormat.format(stats.cases);
  elements.metricRejects.textContent = numberFormat.format(stats.rejects);
  elements.metricUndefined.textContent = numberFormat.format(stats.undefined);
  elements.metricQueue.textContent = numberFormat.format(stats.enqueued);
  elements.metricRendered.textContent = numberFormat.format(
    buildStateSpaceGraph(viewState.renderRoot).nodes.length,
  );
}

function renderRules(): void {
  const counts = new Map<string, number>();
  for (const node of viewState.nodes) {
    const rule = node.decision?.ruleId;
    if (rule) {
      counts.set(rule, (counts.get(rule) ?? 0) + 1);
    }
  }

  const all = document.createElement("button");
  all.type = "button";
  all.className = `rule-button${viewState.activeRule === "all" ? " active" : ""}`;
  all.innerHTML = "<b>全部规则</b><span>取消规则高亮</span>";
  all.addEventListener("click", () => {
    viewState.activeRule = "all";
    renderAll();
  });

  const buttons = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([rule, count]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `rule-button${viewState.activeRule === rule ? " active" : ""}`;
      button.innerHTML = `<b>${rule} · ${numberFormat.format(count)}</b><span>${sampleRuleText(rule)}</span>`;
      button.addEventListener("click", () => {
        viewState.activeRule = rule;
        renderAll();
      });
      return button;
    });

  elements.ruleList.replaceChildren(all, ...buttons);
}

function renderGraph(): void {
  const svg = d3.select(elements.tree);
  svg.selectAll("*").remove();

  const graph = buildStateSpaceGraph(viewState.renderRoot);
  graphNodeIndex = new Map(graph.nodes.map((node) => [node.id, node]));

  const viewportWidth = elements.tree.clientWidth || 1120;
  const viewportHeight = elements.tree.clientHeight || 820;
  elements.tree.setAttribute("viewBox", `0 0 ${viewportWidth} ${viewportHeight}`);

  const group = svg.append("g");
  zoomBehavior = d3
    .zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.06, 3])
    .on("zoom", (event) => group.attr("transform", event.transform));

  const fitScale = Math.max(
    0.06,
    Math.min(1, viewportWidth / graph.width, viewportHeight / graph.height),
  );
  defaultTransform = d3.zoomIdentity.translate(40, 34).scale(0.92);
  fitTransform = d3.zoomIdentity.translate(26, 28).scale(fitScale);
  svg.call(zoomBehavior).call(zoomBehavior.transform, defaultTransform);

  renderColumnBands(group, graph);

  group
    .append("g")
    .attr("class", "edge-layer")
    .selectAll<SVGPathElement, GraphEdgeDatum>("path")
    .data(graph.edges)
    .join("path")
    .attr("class", (edge) => `graph-edge${isEdgeDimmed(edge) ? " dimmed" : ""}`)
    .attr("d", edgePath);

  const node = group
    .append("g")
    .attr("class", "node-layer")
    .selectAll("g.graph-node")
    .data(graph.nodes)
    .join("g")
    .attr("class", (item) => graphNodeClass(item))
    .attr("transform", (item) => `translate(${item.x},${item.y})`)
    .on("click", (event, item) => {
      event.stopPropagation();
      viewState.selectedId = item.id;
      updateSelectedNodeClasses();
      renderDetail(item);
    });

  node
    .append("rect")
    .attr("width", (item) => item.width)
    .attr("height", (item) => item.height)
    .attr("rx", 8);

  node
    .append("text")
    .attr("class", "type")
    .attr("x", 12)
    .attr("y", 17)
    .text((item) => nodeTypeLabel(item));

  node
    .append("text")
    .attr("class", "count")
    .attr("x", (item) => item.width - 12)
    .attr("y", 17)
    .attr("text-anchor", "end")
    .text((item) =>
      item.members.length > 1 ? `x${numberFormat.format(item.members.length)}` : "",
    );

  node
    .append("text")
    .attr("class", "title")
    .attr("x", 12)
    .attr("y", 39)
    .text((item) => shortText(item.title, 30));

  node
    .append("text")
    .attr("class", "subtitle")
    .attr("x", 12)
    .attr("y", 58)
    .text((item) => shortText(item.subtitle, 34));
}

function buildStateSpaceGraph(root: TraceNode): StateSpaceGraph {
  const nodesById = new Map<string, GraphNodeDatum>();
  const edgeIds = new Set<string>();
  const edgeRefs: Array<{ sourceId: string; targetId: string; decision?: Decision }> = [];

  visitGraph(root, undefined, 0);

  const nodes = [...nodesById.values()];
  const columns = [...new Set(nodes.map((node) => node.column))].sort((a, b) => a - b);
  const columnWidth = 304;
  const rowGap = 14;
  const headerHeight = 56;
  const left = 28;
  const top = 58;
  let graphHeight = 600;

  for (const column of columns) {
    const columnNodes = nodes
      .filter((node) => node.column === column)
      .sort((a, b) => graphSortKey(a).localeCompare(graphSortKey(b), "zh-CN"));

    columnNodes.forEach((node, index) => {
      node.x = left + column * columnWidth;
      node.y = top + headerHeight + index * (node.height + rowGap);
    });
    const height = top + headerHeight + columnNodes.length * (76 + rowGap) + 80;
    graphHeight = Math.max(graphHeight, height);
  }

  const graphWidth = left + (Math.max(...columns, 0) + 1) * columnWidth + 280;
  const edges: GraphEdgeDatum[] = edgeRefs
    .map((edge): GraphEdgeDatum | undefined => {
      const source = nodesById.get(edge.sourceId);
      const target = nodesById.get(edge.targetId);
      if (!source || !target) {
        return undefined;
      }
      const id = `${edge.sourceId}->${edge.targetId}`;
      return edge.decision
        ? { id, source, target, decision: edge.decision }
        : { id, source, target };
    })
    .filter((edge): edge is GraphEdgeDatum => Boolean(edge));

  return {
    nodes,
    edges,
    columns,
    width: graphWidth,
    height: graphHeight,
  };

  function visitGraph(
    node: TraceNode,
    parent: GraphNodeDatum | undefined,
    depth: number,
  ): GraphNodeDatum {
    const id = graphNodeId(node, parent?.id, depth);
    let datum = nodesById.get(id);
    if (datum) {
      datum.members.push(node);
    } else {
      datum = {
        id,
        kind: node.kind,
        representative: node,
        members: [node],
        title: node.title,
        subtitle: node.subtitle,
        detail: node.detail,
        context: node.context,
        candidate: node.candidate,
        decision: node.decision,
        caseId: node.caseId,
        e2e: node.e2e,
        column: columnFor(node, depth),
        x: 0,
        y: 0,
        width: widthFor(node),
        height: 76,
      };
      nodesById.set(id, datum);
    }

    if (parent) {
      const edgeId = `${parent.id}->${datum.id}`;
      if (!edgeIds.has(edgeId)) {
        edgeIds.add(edgeId);
        edgeRefs.push({
          sourceId: parent.id,
          targetId: datum.id,
          decision: node.decision ?? parent.decision,
        });
      }
    }

    for (const child of node.children) {
      visitGraph(child, datum, depth + 1);
    }
    return datum;
  }
}

function renderColumnBands(
  group: d3.Selection<SVGGElement, unknown, null, undefined>,
  graph: StateSpaceGraph,
): void {
  const bandWidth = 282;
  const left = 18;
  const labelTop = 18;
  const columnWidth = 304;

  const bands = group.append("g").attr("class", "column-bands");
  const column = bands
    .selectAll("g.column-band")
    .data(graph.columns)
    .join("g")
    .attr("class", "column-band")
    .attr("transform", (item) => `translate(${left + item * columnWidth},0)`);

  column
    .append("rect")
    .attr("x", 0)
    .attr("y", 8)
    .attr("width", bandWidth)
    .attr("height", graph.height - 24)
    .attr("rx", 8);

  column
    .append("text")
    .attr("x", 10)
    .attr("y", labelTop)
    .text((item) => columnLabel(item));
}

function graphNodeId(node: TraceNode, parentId: string | undefined, depth: number): string {
  const round = Math.floor(depth / 4) + 1;
  if (node.kind === "state") {
    return `state:${round}:${contextKey(node.context)}`;
  }
  if (node.kind === "candidate") {
    return `${parentId ?? "root"}:action:${node.candidate?.id ?? slug(node.title)}`;
  }
  if (node.kind === "guard") {
    return `${parentId ?? "root"}:guard:${node.decision?.kind ?? "none"}:${node.decision?.ruleId ?? slug(node.title)}`;
  }
  if (node.kind === "effect") {
    return `${parentId ?? "root"}:effect:${node.decision?.kind ?? "none"}:${node.decision?.ruleId ?? slug(node.title)}:${contextKey(node.context)}`;
  }
  if (node.kind === "summary") {
    return `${parentId ?? "root"}:summary:${slug(node.title)}`;
  }
  return `case:${node.caseId ?? node.id}`;
}

function columnFor(node: TraceNode, depth: number): number {
  const round = Math.floor(depth / 4);
  if (node.kind === "case" || node.kind === "summary") {
    return round * 5 + 4;
  }
  return round * 5 + (depth % 4);
}

function widthFor(node: TraceNode): number {
  if (node.kind === "case") {
    return 264;
  }
  if (node.kind === "state") {
    return 268;
  }
  return 252;
}

function columnLabel(column: number): string {
  const round = Math.floor(column / 5) + 1;
  const slot = column % 5;
  if (slot === 0) {
    return `R${round} · State`;
  }
  if (slot === 1) {
    return "Action";
  }
  if (slot === 2) {
    return "Guard";
  }
  if (slot === 3) {
    return "Effect";
  }
  return "Case / Review";
}

function graphSortKey(node: GraphNodeDatum): string {
  return [
    String(node.decision ? decisionRank(node.decision.kind) : 0),
    node.kind,
    node.decision?.ruleId ?? "",
    node.title,
    node.subtitle,
  ].join("|");
}

function decisionRank(kind: DecisionKind): number {
  if (kind === "reject") {
    return 1;
  }
  if (kind === "undefined") {
    return 2;
  }
  if (kind === "enqueue") {
    return 3;
  }
  if (kind === "allow") {
    return 4;
  }
  return 5;
}

function edgePath(edge: GraphEdgeDatum): string {
  const sx = edge.source.x + edge.source.width;
  const sy = edge.source.y + edge.source.height / 2;
  const tx = edge.target.x;
  const ty = edge.target.y + edge.target.height / 2;
  const mid = sx + Math.max(36, (tx - sx) * 0.5);
  return `M${sx},${sy} C${mid},${sy} ${mid},${ty} ${tx},${ty}`;
}

function renderDetail(graphNode?: GraphNodeDatum): void {
  if (!graphNode) {
    elements.nodePopover.hidden = true;
    elements.reviewButtons.replaceChildren();
    elements.detailPath.replaceChildren();
    return;
  }

  const node = graphNode.representative;
  elements.nodePopover.hidden = false;
  elements.detailTitle.textContent = graphNode.title;
  elements.detailKind.textContent = [
    graphNode.kind,
    graphNode.members.length > 1
      ? `命中 ${numberFormat.format(graphNode.members.length)} 条 trace`
      : "",
    node.decision ? decisionLabel(node.decision) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  elements.detailContext.textContent = contextLabel(graphNode.context);
  elements.detailText.textContent = graphNode.detail;
  elements.detailE2e.textContent = node.e2e ?? node.decision?.assertion ?? "-";
  renderReviewButtons(graphNode);

  const path = findPath(viewState.root, node.id);
  elements.detailPath.replaceChildren(
    ...path.map((item) => {
      const li = document.createElement("li");
      li.textContent = `${item.kind}: ${item.title}`;
      return li;
    }),
  );
}

function renderReviewButtons(graphNode = selectedGraphNode()): void {
  const node = graphNode?.representative;
  elements.reviewButtons.replaceChildren(
    ...statusOptions.map((status) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `review-button${node?.caseId && viewState.review[node.caseId] === status ? " active" : ""}`;
      button.textContent = status;
      button.disabled = !node?.caseId;
      button.addEventListener("click", () => {
        if (!node?.caseId) {
          return;
        }
        viewState.review[node.caseId] = status;
        localStorage.setItem(reviewKey, JSON.stringify(viewState.review));
        renderReviewButtons(graphNode);
      });
      return button;
    }),
  );
}

function updateSelectedNodeClasses(): void {
  d3.select(elements.tree)
    .selectAll<SVGGElement, GraphNodeDatum>("g.graph-node")
    .attr("class", (item) => graphNodeClass(item));
}

function cloneForRender(node: TraceNode, budget: RenderBudget): TraceNode {
  if (budget.remaining <= 0) {
    return summaryNode(node, 1);
  }
  budget.remaining -= 1;
  const children: TraceNode[] = [];
  let hidden = 0;

  for (const child of node.children) {
    if (budget.remaining <= 0) {
      hidden += countNodes(child);
      continue;
    }
    children.push(cloneForRender(child, budget));
  }

  if (hidden > 0) {
    children.push(summaryNode(node, hidden));
  }

  return { ...node, children };
}

function summaryNode(parent: TraceNode, hidden: number): TraceNode {
  return {
    id: `${parent.id}-summary-${hidden}`,
    kind: "summary",
    title: `聚合 ${numberFormat.format(hidden)} 个节点`,
    subtitle: "超过当前渲染预算",
    detail: "完整语义仍然参与统计和 JSON 导出，只是画布里折叠显示。",
    context: parent.context,
    children: [],
  };
}

function countNodes(node: TraceNode): number {
  let count = 1;
  for (const child of node.children) {
    count += countNodes(child);
  }
  return count;
}

function isGraphDimmed(node: GraphNodeDatum): boolean {
  const ruleMatched =
    viewState.activeRule === "all" ||
    node.members.some((member) => member.decision?.ruleId === viewState.activeRule);
  const decisionMatched =
    viewState.activeDecision === "all" ||
    node.members.some((member) => member.decision?.kind === viewState.activeDecision);
  return !ruleMatched || !decisionMatched;
}

function isEdgeDimmed(edge: GraphEdgeDatum): boolean {
  return isGraphDimmed(edge.source) && isGraphDimmed(edge.target);
}

function graphNodeClass(node: GraphNodeDatum): string {
  const classes = ["graph-node", node.kind];
  if (node.decision) {
    classes.push(node.decision.kind);
  }
  if (isLongRunningState(node)) {
    classes.push("long-task");
  }
  if (isGraphDimmed(node)) {
    classes.push("dimmed");
  }
  if (viewState.selectedId === node.id) {
    classes.push("selected");
  }
  return classes.join(" ");
}

function nodeTypeLabel(node: GraphNodeDatum): string {
  if (node.kind === "state" && isLongRunningState(node)) {
    return "State · long task";
  }
  if (node.kind === "candidate" && node.candidate?.kind === "system") {
    return "System event";
  }
  if (node.kind === "candidate") {
    return "User action";
  }
  if (node.kind === "guard") {
    return "Guard";
  }
  if (node.kind === "effect") {
    return "Effect";
  }
  if (node.kind === "case") {
    return "Case";
  }
  if (node.kind === "summary") {
    return "Folded";
  }
  return "State";
}

function isLongRunningState(node: GraphNodeDatum): boolean {
  return (
    node.kind === "state" &&
    (node.context.runPhase === "running" ||
      node.context.runPhase === "compacting" ||
      node.context.runPhase === "goalVerifying")
  );
}

function selectedGraphNode(): GraphNodeDatum | undefined {
  if (!viewState.selectedId) {
    return undefined;
  }
  return graphNodeIndex.get(viewState.selectedId);
}

function findPath(root: TraceNode, id: string): TraceNode[] {
  const path: TraceNode[] = [];
  const found = walk(root);
  return found ? path : [root];

  function walk(node: TraceNode): boolean {
    path.push(node);
    if (node.id === id) {
      return true;
    }
    for (const child of node.children) {
      if (walk(child)) {
        return true;
      }
    }
    path.pop();
    return false;
  }
}

function readReview(): Record<string, ReviewStatus> {
  try {
    return JSON.parse(localStorage.getItem(reviewKey) || "{}") as Record<string, ReviewStatus>;
  } catch {
    return {};
  }
}

function exportCases(): void {
  const cases = viewState.nodes
    .filter((node) => node.kind === "case")
    .map((node) => ({
      id: node.caseId,
      status: node.caseId ? (viewState.review[node.caseId] ?? "unreviewed") : "unreviewed",
      title: node.subtitle,
      context: contextLabel(node.context),
      decision: node.decision?.kind,
      ruleId: node.decision?.ruleId,
      action: node.candidate?.label,
      e2e: node.e2e,
      path: findPath(viewState.root, node.id).map((item) => item.title),
    }));
  const blob = new Blob([JSON.stringify(cases, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "conversation-state-space-cases.json";
  link.click();
  URL.revokeObjectURL(url);
}

function applyTransform(transform: d3.ZoomTransform | null): void {
  if (!zoomBehavior || !transform) {
    return;
  }
  d3.select(elements.tree).transition().duration(180).call(zoomBehavior.transform, transform);
}

function zoomBy(factor: number): void {
  if (!zoomBehavior) {
    return;
  }
  d3.select(elements.tree).transition().duration(180).call(zoomBehavior.scaleBy, factor);
}

function sampleRuleText(ruleId: string): string {
  const node = viewState.nodes.find((item) => item.decision?.ruleId === ruleId);
  return node?.decision?.reason ?? "规则命中路径";
}

function shortText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-|-$/g, "");
}

function mustQuery<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }
  return element;
}
