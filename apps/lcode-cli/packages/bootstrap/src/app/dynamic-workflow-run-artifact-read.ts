// ============================================================
// 用户面产物的字节读回（DynamicWorkflowRunPort.readArtifact 的实现体）
// ============================================================
//
// ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给**用户**看的产出（journal
// `kind = "artifact"` 的行），**不是**引擎内部的 `RunSettlement.artifact`（脚本顶层返回值，
// 端口上叫 `output` / `result`）。
//
// 从 dynamic-workflow-run-service.ts 拆出（那个文件已在 max-lines 的既有欠账里，不再加码），
// 与把 driver 的发布路径拆成 workflow-artifact-publish.ts 是同一条理由：读一次字节
// 要走「授权 → 定位 → store」三步，每一步都有一条必须写下来的纪律。
//
// **授权链**（与 attachmentRead 同一条纪律）：
//
//   调用方给的 (runId, artifactId, version)
//        │
//        ├─① runId 的 dwf_run 行存在吗？                     否 ⇒ undefined
//        ├─② 该行的 parent_session_id == 本服务的父会话吗？   否 ⇒ undefined
//        ├─③ journal 里有 (artifactId, version) 的 completed  否 ⇒ undefined
//        │    artifact 行吗？
//        ├─④ 那行的记录上有 uri 吗？（预置看板没有）          否 ⇒ undefined
//        └─⑤ 拿**行上的** uri 去 store 读
//
// 第 ⑤ 步是全部要点：renderer 传来的 id 只用于**在 journal 里查行**，从不直接成为路径。
// 中间任何一步失败都回 undefined 而不是抛错——「没有这个版本」「不是你的 run」「这是个看板」
// 对调用方是同一个业务事实（网关归一成 not found），把它们区分开只会告诉一个越权的调用方
// 它猜对了哪一半。

import type {
  DynamicWorkflowRunArtifactBytes,
  ToolArtifactStorePort,
} from "@lcode/contracts";
import type { JournalStorePort } from "@lcode/dynamic-workflow";

import {
  artifactRowId,
  supportsArtifactReads,
} from "./dynamic-workflow-run-artifact-queries.js";

interface WorkflowArtifactReadDeps {
  journal: JournalStorePort;
  /** 本服务的父会话（= 本 app 的会话）。授权链第 ② 步的比对对象。 */
  parentSessionId: string;
  /**
   * 字节的家。**可选**：纯 replay / 无 store 的装配拿不到字节，此时整条读回缺席
   * （与 driver 侧 `ArtifactStoreUnavailable` 是同一个装配事实的两个表现）。
   */
  artifactStore?: ToolArtifactStorePort;
}

/**
 * 读某个产物版本的全部字节。分块归网关（≤ 512 KiB 一块），这里一次返回整份——上限
 * 20 MiB 与 attachment 同级，与「读一次算一次授权」比起来，把授权链切进分块循环里
 * 只会让每一块都要重走一遍 journal。
 */
export async function readWorkflowArtifactBytes(
  deps: WorkflowArtifactReadDeps,
  runId: string,
  artifactId: string,
  version: number,
): Promise<DynamicWorkflowRunArtifactBytes | undefined> {
  const store = deps.artifactStore;
  // 二进制读回是**可选成员**：不带它的 store 不得退回文本读再解码——那正是
  // 记录在 ToolBinaryArtifactReadResult 上的那条 bug（office 文件被当 utf8 解码即损坏）。
  if (store?.readToolResultBinaryArtifact === undefined) return undefined;

  // ①②：run 存在且属于本会话。getRun 在引擎端口上，不需要内省能力探测。
  const run = deps.journal.getRun(runId);
  if (run === undefined) return undefined;
  // parent_session_id 为 NULL 的老行**不放行**：设计上要求 sessionId 等于该 run 的
  // parentSessionId，而 NULL 意味着没有这个东西可比——「无从判定」不是「判定通过」。
  if (run.parentSessionId === undefined || run.parentSessionId !== deps.parentSessionId) {
    return undefined;
  }

  // ③④：在 journal 里定位那一行，拿行上的 uri。
  const located = locateArtifactVersion(deps.journal, runId, artifactId, version);
  if (located === undefined) return undefined;

  // ⑤：只有走到这里才碰 store，而喂给它的是**行上的** uri。
  const result = await store.readToolResultBinaryArtifact({ uri: located.uri });
  return {
    bytes: result.bytes,
    // contentType 取 **journal 记录**上的值而不是 store 按文件名再推的那份：记录里的是
    // driver 按扩展名表算出、`opts.contentType` 可覆盖的那一个，也正是 UI 分派渲染器的
    // 精确匹配契约。store 的推断表只认 8 种扩展名，用它会让 `.csv` 变成 application/json。
    contentType: located.contentType ?? result.contentType,
  };
}

/**
 * 在 journal 里找 `(artifactId, version)` 的那条 **completed** artifact 行，并取出它的
 * `uri` 与 `contentType`。
 *
 * 只认 completed：失败的发布不认领 id / 种类 / 版本，它的 `result` 是空的，
 * 放行只会拿一个 undefined 的 uri 去读。预置看板的记录没有 `uri`（它没有字节，它的数据是
 * journal 里的标签 report 行）——同样在这里被挡掉，调用方拿到 undefined。
 */
function locateArtifactVersion(
  journal: JournalStorePort,
  runId: string,
  artifactId: string,
  version: number,
): { uri: string; contentType?: string } | undefined {
  if (!supportsArtifactReads(journal)) return undefined;
  for (const row of journal.listArtifactRows(runId)) {
    if (row.status !== "completed") continue;
    if (artifactRowId(row) !== artifactId) continue;
    const record = row.result;
    if (record === null || typeof record !== "object" || Array.isArray(record)) continue;
    const fields = record as Record<string, unknown>;
    if (fields.version !== version) continue;
    const uri = typeof fields.uri === "string" && fields.uri.length > 0 ? fields.uri : undefined;
    if (uri === undefined) return undefined;
    const contentType =
      typeof fields.contentType === "string" && fields.contentType.length > 0
        ? fields.contentType
        : undefined;
    return { uri, ...(contentType === undefined ? {} : { contentType }) };
  }
  return undefined;
}
