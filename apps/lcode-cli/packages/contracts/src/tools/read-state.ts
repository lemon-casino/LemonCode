// ============================================================
// Read State Contract
// ============================================================

export interface ReadFileState {
  path: string;
  mtime: number;
  content: string;
  offset?: number;
  limit?: number;
  isPartialView: boolean;
  readAt: Date;
}
