export const MEMORY_RECALL_TYPES = ["user", "feedback", "project", "reference"] as const;

export type MemoryRecallType = (typeof MEMORY_RECALL_TYPES)[number];

export interface MemoryManifestEntry {
  description?: string;
  filePath: string;
  filename: string;
  mtimeMs: number;
  type?: MemoryRecallType;
}

export interface IndexedMemoryDocument extends MemoryManifestEntry {
  content: string;
  indexedBytes: number;
  metadataTokens: ReadonlySet<string>;
  sourceMtimeMs?: number;
  termFrequencies: ReadonlyMap<string, number>;
  tokenCount: number;
}

export interface RankedMemoryDocument {
  document: IndexedMemoryDocument;
  score: number;
}

export interface MemoryRecallResult extends MemoryManifestEntry {
  content: string;
  score: number;
}

export interface ProjectMemoryRecallOutcome {
  attachment?: string;
  candidateCount: number;
  indexedCount: number;
  matchCount: number;
  results: readonly MemoryRecallResult[];
}
