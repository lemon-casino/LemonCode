/** 图片字节由父会话附件仓储持有，引擎仅保存可恢复的引用。 */
export interface WorkflowImageRef {
  ref: string;
  fileName: string;
  mime: string;
  bytes: number;
  previewRef?: string;
}
