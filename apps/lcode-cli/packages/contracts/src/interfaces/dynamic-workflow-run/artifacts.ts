/**
 * 一个用户面产物的一个版本（journal `dwf_node.result_json` 上 `ArtifactVersionRecord` 的
 * JSON 镜像）。**刻意在这里重新声明**而不是从 @lcode/dynamic-workflow import：端口只承载
 * JSON 形状（与 {@link DynamicWorkflowRunLifecycleStatus} 同一条论证）。
 *
 * 内容产物（`file` / `markdown`）填 `contentType` / `bytes` / `uri` / `sourcePath`；预置看板
 * （`chart` / `table` / `metrics` / `board`）填 `spec`。字节永不在这里——`uri` 指向
 * tool-artifact store。
 */
export interface DynamicWorkflowRunArtifactVersion {
  version: number;
  title?: string;
  description?: string;
  contentType?: string;
  bytes?: number;
  uri?: string;
  sourcePath?: string;
  spec?: unknown;
  /** 发布时刻（epoch 毫秒）。driver 恒写入。 */
  publishedAt: number;
  /** 这一版属于 run 的交付物。 */
  primary?: true;
}

/** 用户面产物的成员种类（facade `artifact.*` 的六个成员）。 */
export type DynamicWorkflowRunArtifactKind =
  | "file"
  | "markdown"
  | "chart"
  | "table"
  | "metrics"
  | "board";

/**
 * 一个用户面产物：id 下的全部版本（按版本号升序）+ 喂给它的标签 report 计数。
 * `title` / `description` / `contentType` / `sourcePath` / `spec` 取**最新版**的值，方便
 * 只关心「现在是什么」的读者不必自己翻 versions。
 */
export interface DynamicWorkflowRunArtifact {
  id: string;
  kind: DynamicWorkflowRunArtifactKind;
  title?: string;
  description?: string;
  contentType?: string;
  sourcePath?: string;
  spec?: unknown;
  /** 最新版号（= versions 末项的 version）。 */
  version: number;
  versions: readonly DynamicWorkflowRunArtifactVersion[];
  /** 打了这个 id 标签的 `report` 条目数（预置看板的数据量；内容产物恒 0）。 */
  itemCount: number;
  /** run 的交付物（至多一件）。`artifacts` 清单以它带头，其余按首次发布顺序。 */
  primary?: true;
}

/** 喂给某个预置产物的一条 `report` 条目，按 journal sequence 定位（看板的取数面）。 */
export interface DynamicWorkflowRunArtifactItem {
  sequence: number;
  siteId: string;
  ordinal: number;
  item: unknown;
}

/** {@link DynamicWorkflowRunPort.listArtifactItems} 的分页袋（cursor = journal sequence，严格大于）。 */
export interface DynamicWorkflowRunArtifactItemPage {
  afterSequence?: number;
  /** 必填；调用方可传「上限 + 1」探测 hasMore，实现方不得再钳。 */
  limit: number;
}

/** {@link DynamicWorkflowRunPort.readArtifact} 的返回：某个版本的全部字节。 */
export interface DynamicWorkflowRunArtifactBytes {
  bytes: Uint8Array;
  contentType: string;
}
