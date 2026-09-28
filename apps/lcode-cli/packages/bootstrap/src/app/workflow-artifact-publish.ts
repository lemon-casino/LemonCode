// ============================================================
// 产物发布的执行侧（Boundary B 的 executeArtifactPublish）
// ============================================================
// ⚠ 术语：本文件里的 artifact 一律指**用户面
// 产物**——脚本经 `artifact.file` / `artifact.markdown` 交付给**用户**看的字节；不是引擎内部
// 那个 artifact（`RunSettlement.artifact`、`serializeWorkflowArtifact` 的顶层返回值，那是给
// **模型**看的）。本文件不触及后者。
//
// 与 workflow-world-read.ts 同一条分工线：driver 本体（workflow-driver.ts）做 actor 会话与
// turn 的编排，这一半把一次 `(op, id, path | content, opts)` 变成一次真实的**字节拷贝**，
// 且完全不碰会话、模型与 journal。四件事在这里，而且只在这里：
//   1. **实参与 opts 的形状校验**。引擎只保证 `id` 与 payload 是非空字符串（运行期护栏），
//      `opts` 是脚本原样透传的第三实参——「一个 title 长什么样」归这一侧，纪律与
//      `worldReadStringArgs` 相同：大声失败，绝不 `String(...)` 强转。
//   2. **路径解析与越界判定**。解析器复用 world-read 的那一个（`resolveWithinWorkspace`），
//      再加一次 realpath 复核，见 {@link resolveWorkspaceFile}。
//   3. **上限的执行**。常量在纯包（`ARTIFACT_CAPS`），执行在这里，因为只有这一侧读得到
//      字节；超限一律**拒绝不截断**（与 world-read 同 house policy——一份被悄悄截断的 PDF
//      是一件坏交付物，而一条指名上限的拒绝是脚本能据以改写自己的契约）。
//   4. **写 tool-artifact store**，并把 store 的回执归一成 `ArtifactVersionRecord`。
//
// 拒绝一律是结构化 `WorkflowError`（错误码：ArtifactSourceMissing /
// ArtifactPathOutsideWorkspace / ArtifactTooLarge / ArtifactStoreUnavailable），因为内容成员
// 在脚本里是一个可 `catch` 的 promise——门控习语 `try { await artifact.file(…) } catch { … }`
// 的前提就是这些拒绝到得了脚本手上。

import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import {
  isFileSystemPortError,
  type FileSystemPort,
  type FileSystemReadBytesResult,
  type SessionId,
  type ToolArtifactStorePort,
  type ToolArtifactWriteResult,
} from "@lcode/contracts";
import {
  ARTIFACT_CAPS,
  ARTIFACT_ID_PATTERN,
  WorkflowError,
  type ArtifactPublishRequest,
  type ArtifactVersionRecord,
} from "@lcode/dynamic-workflow";
import { resolveWithinWorkspace, toWorkspaceRelative } from "./workflow-world-read.js";

/** 产物发布需要的端口与基准目录（driver deps 的一个子集，同 {@link WorldReadDeps}）。 */
interface ArtifactPublishDeps {
  /** 读取被发布文件的字节所用的文件系统端口。 */
  readonly fileSystemPort: FileSystemPort;
  /** 路径解析与相对化的基准目录（workspace 根）。 */
  readonly cwd: string;
  /**
   * 字节的落点。**可选**：纯 replay / fake 装配没有 store。
   * 缺席时内容成员以 `ArtifactStoreUnavailable` 大声拒绝——不是静默降级成
   * 「发布了一个空产物」，也不是退回写工作区。
   */
  readonly artifactStore?: ToolArtifactStorePort;
  /**
   * store 写入的会话作用域 = 本 run 的**父会话**。与 `artifactStore`
   * 成对出现：store 的每次写入都按会话记账（`lcode-artifact://<session>/<id>`），没有会话 id
   * 就写不出一条日后读得回来的记录。两者都在场才算装配了发布能力，缺一即
   * `ArtifactStoreUnavailable`（缺 store 是「这个装配没有存储」，缺 id 是接线错误——两者对
   * 脚本是同一件事：这次发布做不了，且必须大声）。
   */
  readonly parentSessionId?: SessionId;
}

/**
 * 执行一次内容产物发布：校验形状 → 确认 store 在场 → 取字节（文件读盘 / markdown 正文）→
 * 写 store → 归一成落库记录。
 *
 * 顺序不是随意的：**先形状、再 store、最后 IO**。形状校验最便宜且与装配无关；store 缺席时
 * 一次读盘是白做的功，更糟的是它会用一条 `ArtifactSourceMissing` 盖掉真正的病因
 * （「这个装配根本没有存储」）。
 */
export async function executeArtifactPublish(
  deps: ArtifactPublishDeps,
  request: ArtifactPublishRequest,
): Promise<ArtifactVersionRecord> {
  assertArtifactId(request);
  const opts = artifactPublishOptions(request);
  const store = requireArtifactStore(deps, request);
  const payload =
    request.op === "file"
      ? await readFilePayload(deps, request, opts)
      : markdownPayload(request);
  const written = await writePayload(store, request, payload);
  return {
    id: request.id,
    kind: request.op,
    version: request.version,
    ...(opts.title === undefined ? {} : { title: opts.title }),
    ...(opts.description === undefined ? {} : { description: opts.description }),
    // contentType 取**本地算出的**那一个而不是 store 的回执：扩展名表 + `opts.contentType`
    // 覆盖共同决定内容类型，UI 在这个字符串上做 switch 分派；让 store 的归一化（它按
    // 落盘文件名回推类型）成为权威，会让一次分派结果取决于 store 实现。
    contentType: payload.contentType,
    // bytes / uri 取 store 的回执：那是**真正落进 store 的那一份**，也是日后读回来的那一份。
    bytes: written.bytes,
    uri: written.uri,
    ...(payload.kind === "binary" ? { sourcePath: payload.sourcePath } : {}),
    // 引擎没有时钟（纯核心，可重放），所以发布时刻由这一侧填。发布时刻为必填字段。
    publishedAt: Date.now(),
  };
}

// ——————————————————————————————— 内部：形状校验 ———————————————————————————————

/** 校验过的 `opts`（facade 的 `ArtifactOptions` / `ArtifactFileOptions`）。 */
interface ArtifactPublishOptions {
  title?: string;
  description?: string;
  /** 只有 `file` 读它：markdown 恒 `text/markdown`。 */
  contentType?: string;
}

/**
 * 产物 id 的运行期护栏。编译期的字面量诊断（分析器）是正门，引擎又挡了一次「必须是非空
 * 字符串」——这里再验字符集与长度，是因为**只有这一侧把 id 当键用**：它进 store 的
 * `toolCallId`，最终成为落盘文件名的一段。走到这里的非法 id 只可能是有东西绕过了编译，
 * 用 `DriverError` 而不是某个 `Artifact*` 码，让那些码只表示它们各自的那件事。
 */
function assertArtifactId(request: ArtifactPublishRequest): void {
  const { id } = request;
  if (id.length > ARTIFACT_CAPS.maxIdLength || !ARTIFACT_ID_PATTERN.test(id)) {
    throw new WorkflowError(
      "DriverError",
      `artifact.${request.op}: id '${id}' is not a valid artifact id. Use at most ` +
        `${ARTIFACT_CAPS.maxIdLength} characters from [A-Za-z0-9_.-].`,
    );
  }
}

/**
 * 取出并校验脚本给的 `opts`。三条规则与 {@link worldRunArgs} 同源：
 *   1. 缺席合法（`opts?`），在场必须是选项对象（不是数组、不是 null）。
 *   2. 认识的键逐个验类型与上限，**绝不强转**——一个被 `String(undefined)` 变成
 *      `"undefined"` 的标题，会在卡片上显示成一个查不明白的字符串而不是一条能改的错误。
 *   3. 不认识的键静默忽略（facade 的类型签名在编译期就拦住了它们；运行期为它们报错只会
 *      把一个编译期问题搬到运行期）。`markdown` 一族因此根本不读 `contentType`。
 */
function artifactPublishOptions(request: ArtifactPublishRequest): ArtifactPublishOptions {
  const raw = request.opts;
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WorkflowError(
      "DriverError",
      `artifact.${request.op}: opts must be an options object, got ${describeArg(raw)}. ` +
        `Pass an object or omit the argument.`,
    );
  }
  const bag = raw as { title?: unknown; description?: unknown; contentType?: unknown };
  const title = optionalText(request, "title", bag.title, ARTIFACT_CAPS.maxTitleLength);
  const description = optionalText(
    request,
    "description",
    bag.description,
    ARTIFACT_CAPS.maxDescriptionLength,
  );
  const contentType = request.op === "file" ? optionalContentType(request, bag.contentType) : undefined;
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(contentType === undefined ? {} : { contentType }),
  };
}

/** 一个可选的有界文本选项（title / description）。长度按字符数（UTF-16 码元）计。 */
function optionalText(
  request: ArtifactPublishRequest,
  name: string,
  value: unknown,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new WorkflowError(
      "DriverError",
      `artifact.${request.op}: opts.${name} must be a string, got ${describeArg(value)}.`,
    );
  }
  if (value.length > max) {
    // 拒绝而不是截断：一个被砍掉后半句的标题是一件**看起来正常**的坏交付物，而卡片上
    // 没有任何地方能显示"这里被截过"。
    throw new WorkflowError(
      "ArtifactTooLarge",
      `artifact.${request.op}: opts.${name} is ${value.length} characters, over the cap of ` +
        `${max}. Shorten it.`,
    );
  }
  return value;
}

/**
 * `opts.contentType` 的覆盖值。要求是**不带参数的**裸 MIME（`type/subtype`）：这个字符串的
 * 消费者是 UI 的一个精确分派（`text/markdown` 走 markdown 卡、`application/pdf` 走 pdf 卡），
 * 一条 `text/markdown; charset=utf-8` 会整条错过那个分支，表现是「明明写了类型却掉进下载卡」。
 */
function optionalContentType(request: ArtifactPublishRequest, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new WorkflowError(
      "DriverError",
      `artifact.file: opts.contentType must be a string, got ${describeArg(value)}.`,
    );
  }
  if (!CONTENT_TYPE_PATTERN.test(value)) {
    throw new WorkflowError(
      "DriverError",
      `artifact.file: opts.contentType '${value}' is not a bare MIME type such as ` +
        `'application/pdf'. Drop any parameters ('; charset=...'); the viewer dispatches on ` +
        `the exact string.`,
    );
  }
  return value;
}

// ——————————————————————————————— 内部：取字节 ———————————————————————————————

/** 待写入 store 的一份内容。`file` 走二进制写，`markdown` 走文本写。 */
type ArtifactPayload =
  | {
      readonly kind: "binary";
      readonly bytes: Uint8Array;
      readonly contentType: string;
      /** 落盘文件名的扩展名（store 读回时按文件名回推类型，所以要保真）。 */
      readonly extension?: string;
      /** 工作区相对的原路径（出处 + 「在工作区显示」）。 */
      readonly sourcePath: string;
    }
  | { readonly kind: "text"; readonly text: string; readonly contentType: "text/markdown" };

/**
 * `artifact.file(id, path, opts)`：解析路径 → 读字节（cap+1 探测）→ 定 contentType。
 */
async function readFilePayload(
  deps: ArtifactPublishDeps,
  request: ArtifactPublishRequest,
  opts: ArtifactPublishOptions,
): Promise<ArtifactPayload> {
  const given = request.path;
  if (typeof given !== "string" || given === "") {
    // 引擎已验过 payload 是字符串；空串只可能来自接线错误。
    throw new WorkflowError(
      "DriverError",
      `artifact.file: path must be a non-empty string, got ${describeArg(given)}. Pass the ` +
        `workspace-relative path the subagent wrote.`,
    );
  }
  const { real, relative } = await resolveWorkspaceFile(deps, given);
  const bytes = await readCappedBytes(deps, given, real);
  const extension = fileExtension(real);
  return {
    kind: "binary",
    bytes,
    contentType:
      opts.contentType ??
      (extension === undefined ? undefined : EXTENSION_CONTENT_TYPES[extension]) ??
      // 未列入扩展名表 = 不猜（不做 magic bytes 嗅探）。UI 据此给「下载 / 在工作区
      // 显示」卡而不是渲染一份它读不懂的东西。
      "application/octet-stream",
    ...(extension === undefined ? {} : { extension }),
    sourcePath: relative,
  };
}

/**
 * 把脚本给的**工作区相对**路径解析成一个可读的真实路径，并两次判定越界。
 *
 * 第一次是词法的（{@link resolveWithinWorkspace}，与 `files.read` 同一个判据）；第二次在
 * realpath 之后——**符号链接按解析后的真实路径判越界**。世界读取
 * 那一侧刻意只做词法检查（读出来的字节就是脚本自己看到的值，越界与否脚本自己负责），
 * 这一侧不能照抄：发布把字节**拷进一个持久 store 并摆到用户面前**，一条软链就能让
 * `~/.ssh/id_rsa` 变成一张卡片。这道复核就是那条不变式在写入端的落点。
 *
 * `cwd` 自己也要 realpath：macOS 上 `/tmp` 就是 `/private/tmp` 的软链，不归一的话工作区内的
 * 每一个文件都会被判成越界。
 */
async function resolveWorkspaceFile(
  deps: ArtifactPublishDeps,
  given: string,
): Promise<{ real: string; relative: string }> {
  const resolved = resolveWithinWorkspace(deps.cwd, given);
  if (resolved === undefined) throw outsideWorkspace(given);
  // 出处用的是**脚本给的那个路径**（归一后），不是 realpath：卡片上的「在工作区显示」要
  // 指回用户认得的那个位置，而不是软链的落点。
  const relative = toWorkspaceRelative(deps.cwd, resolved);

  let realCwd: string;
  let real: string;
  try {
    realCwd = await realpath(deps.cwd);
  } catch (cause) {
    throw new WorkflowError(
      "DriverError",
      `artifact.file: cannot resolve the workspace root '${deps.cwd}': ${errorText(cause)}`,
      { cause },
    );
  }
  try {
    real = await realpath(resolved);
  } catch (cause) {
    // ENOENT（含中途某一段不存在）走这里：路径不存在与"指向一个不存在的软链目标"是同一件事。
    throw sourceMissing(given, cause);
  }
  if (resolveWithinWorkspace(realCwd, real) === undefined) throw outsideWorkspace(given);
  return { real, relative };
}

/**
 * 读字节，**cap+1 探测**：端口的 `maxBytes` 是"超了就 `too_large`，不截断"，所以取 cap+1
 * 时，"恰好 cap 字节"（放行）与"超过 cap"（拒绝）可区分，且最坏也只多读一个字节。
 * 与 `files.grep` / `git.diff` 的同一惯用法。
 */
async function readCappedBytes(
  deps: ArtifactPublishDeps,
  given: string,
  path: string,
): Promise<Uint8Array> {
  const cap = ARTIFACT_CAPS.maxFileBytes;
  let result: FileSystemReadBytesResult;
  try {
    result = await deps.fileSystemPort.readBinaryFile({ path, maxBytes: cap + 1 });
  } catch (cause) {
    if (isFileSystemPortError(cause)) {
      if (cause.code === "too_large") throw tooLarge(given, cap);
      // not_found / is_directory / not_file 都是"这里没有一个可发布的普通文件"。
      if (cause.code === "not_found" || cause.code === "is_directory" || cause.code === "not_file") {
        throw sourceMissing(given, cause);
      }
    }
    throw new WorkflowError(
      "DriverError",
      `artifact.file: failed to read '${given}': ${errorText(cause)}`,
      { cause },
    );
  }
  if (result.content.byteLength > cap) throw tooLarge(given, cap);
  return result.content;
}

/** `artifact.markdown(id, content, opts)`：正文按 UTF-8 计字节，超限拒绝。 */
function markdownPayload(request: ArtifactPublishRequest): ArtifactPayload {
  const content = request.content;
  if (typeof content !== "string") {
    throw new WorkflowError(
      "DriverError",
      `artifact.markdown: content must be a string, got ${describeArg(content)}.`,
    );
  }
  const bytes = Buffer.byteLength(content, "utf8");
  const cap = ARTIFACT_CAPS.maxMarkdownBytes;
  if (bytes > cap) {
    throw new WorkflowError(
      "ArtifactTooLarge",
      `artifact.markdown: content is ${bytes} bytes, over the cap of ${cap} bytes. Shorten ` +
        `it, or write the long content to a workspace file and publish it with artifact.file.`,
    );
  }
  return { kind: "text", text: content, contentType: "text/markdown" };
}

// ——————————————————————————————— 内部：写 store ———————————————————————————————

/** 已确认可用的发布落点：store 本体 + 会话作用域（见 {@link ArtifactPublishDeps}）。 */
interface ArtifactStoreTarget {
  readonly store: ToolArtifactStorePort;
  readonly sessionId: SessionId;
}

/**
 * 确认这次发布有落点，否则 `ArtifactStoreUnavailable`。**按 op 分别探测**：文件要二进制写
 * （`writeToolResultBinaryArtifact` 在端口上是可选方法），markdown 只要文本写。一个只有文本
 * 写的 store 因此能发 markdown、发不了文件——而"发不了"是一条命名的拒绝，不是把 PDF 当
 * UTF-8 塞进文本通道（那会静默毁掉字节）。
 */
function requireArtifactStore(
  deps: ArtifactPublishDeps,
  request: ArtifactPublishRequest,
): ArtifactStoreTarget {
  const store = deps.artifactStore;
  if (store === undefined) {
    throw new WorkflowError(
      "ArtifactStoreUnavailable",
      `artifact.${request.op}: cannot publish "${request.id}" because this assembly has no ` +
        `artifact store.`,
    );
  }
  if (request.op === "file" && store.writeToolResultBinaryArtifact === undefined) {
    throw new WorkflowError(
      "ArtifactStoreUnavailable",
      `artifact.file: cannot publish "${request.id}" because this assembly's artifact store ` +
        `does not support binary writes.`,
    );
  }
  const sessionId = deps.parentSessionId;
  if (sessionId === undefined || sessionId === "") {
    // store 在场而会话 id 缺席只可能是接线错误（两者在生产装配里同进同出）。仍然报同一个
    // 码：对脚本而言这是同一件事——这次发布没有落点。
    throw new WorkflowError(
      "ArtifactStoreUnavailable",
      `artifact.${request.op}: cannot publish "${request.id}" because the artifact store has ` +
        `no session scope (parent session id not wired).`,
    );
  }
  return { store, sessionId };
}

/**
 * 写入 store。四个参数的约束如下：
 *   - `retention: "project"`——产物必须活过会话（中枢跨会话读运行历史里的产物）。
 *   - `toolName: "CreateWorkflow"`——发布的归属工具就是启动这个 run 的那一个。
 *   - `toolCallId: `${runId}:${siteId}@${ordinal}``——每一版一份字节，而 (run, 站点, 序号)
 *     恰好唯一标定一次发布（版本号由引擎在 dispatch 前算好，同一版重跑 = 同一个 ordinal）。
 *   - `sessionId` = 父会话。
 */
async function writePayload(
  target: ArtifactStoreTarget,
  request: ArtifactPublishRequest,
  payload: ArtifactPayload,
): Promise<ToolArtifactWriteResult> {
  const common = {
    sessionId: target.sessionId,
    toolCallId: `${request.runId}:${request.siteId}@${request.ordinal}`,
    toolName: ARTIFACT_TOOL_NAME,
    retention: "project" as const,
  };
  try {
    if (payload.kind === "text") {
      return await target.store.writeToolResultArtifact({
        ...common,
        content: payload.text,
        contentType: payload.contentType,
      });
    }
    // 二进制写的存在性已在 requireArtifactStore 里探测过（op === "file" 分支）。
    const writeBinary = target.store.writeToolResultBinaryArtifact;
    if (writeBinary === undefined) {
      throw new WorkflowError(
        "ArtifactStoreUnavailable",
        `artifact.file: cannot publish "${request.id}" because this assembly's artifact store ` +
          `does not support binary writes.`,
      );
    }
    return await writeBinary.call(target.store, {
      ...common,
      content: payload.bytes,
      contentType: payload.contentType,
      // 扩展名随字节一起交给 store：它读回时按落盘文件名回推类型，丢了扩展名就等于把一份
      // .xlsx 读成 application/octet-stream。
      ...(payload.extension === undefined ? {} : { extension: payload.extension }),
    });
  } catch (cause) {
    if (cause instanceof WorkflowError) throw cause;
    // 写失败（磁盘满、权限、store 自身的错误）是一次**具体**的失败，与"没有 store"不是
    // 同一件事，所以不复用 ArtifactStoreUnavailable：带上原因文本，让 journal 里的
    // failure_json 说得出为什么。
    throw new WorkflowError(
      "DriverError",
      `artifact.${request.op}: writing "${request.id}" v${request.version} to the artifact ` +
        `store failed: ${errorText(cause)}`,
      { cause },
    );
  }
}

// ——————————————————————————————— 纯辅助 ———————————————————————————————

/** 产物在 store 里的归属工具名：发布是 `CreateWorkflow` 这次调用的产物。 */
const ARTIFACT_TOOL_NAME = "CreateWorkflow";

/**
 * 扩展名 → MIME。表外的一律 `application/octet-stream`：
 * **不做内容嗅探**（magic bytes 会引入第二个判据，而两个判据迟早会给出两个答案）。
 *
 * 为什么不复用 core 的 `inferAttachmentMimeFromPath`：那张表服务的是**模型输入附件**，
 * 兜底是 `text/plain`（把一切像文本的东西喂给模型是它想要的行为）。这里的消费者是 UI 的
 * 分派，兜底必须是"我不认识它，给下载卡"——同一个兜底在两处的正确值恰好相反。
 */
const EXTENSION_CONTENT_TYPES: Readonly<Record<string, string>> = {
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  htm: "text/html",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  markdown: "text/markdown",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  svg: "image/svg+xml",
  txt: "text/plain",
  webp: "image/webp",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** 裸 MIME（`type/subtype`，不带参数）。见 {@link optionalContentType} 的理由。 */
const CONTENT_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;

/**
 * 文件名的扩展名（小写，不含点）。只认 `[a-z0-9]+`：`archive.tar.gz` 取 `gz`，
 * `Makefile`、`.gitignore`（点开头无后缀）与 `report.v2 final` 一律无扩展名。
 */
function fileExtension(path: string): string | undefined {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return undefined;
  const ext = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]+$/.test(ext) ? ext : undefined;
}

function outsideWorkspace(given: string): WorkflowError {
  return new WorkflowError(
    "ArtifactPathOutsideWorkspace",
    `artifact.file: path '${given}' resolves outside the workspace (symlinks are judged by ` +
      `their real path). Only files inside the workspace can be published.`,
  );
}

function sourceMissing(given: string, cause: unknown): WorkflowError {
  return new WorkflowError(
    "ArtifactSourceMissing",
    `artifact.file: '${given}' does not exist or is not a regular file. Confirm the subagent ` +
      `actually wrote it before publishing.`,
    { cause },
  );
}

function tooLarge(given: string, cap: number): WorkflowError {
  return new WorkflowError(
    "ArtifactTooLarge",
    `artifact.file: '${given}' is over the cap of ${cap} bytes. Publish a smaller artifact ` +
      `(a summary, a slice, or a compressed version).`,
  );
}

/** 实参形状的简短描述（只用于错误消息，不回显完整内容）。 */
function describeArg(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

/** 任意抛出物的单行文本（错误消息用）。 */
function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
