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
  sourceHash?: string;
  sourceMtimeMs?: number;
  termFrequencies: ReadonlyMap<string, number>;
  tokenCount: number;
  truncated?: boolean;
  validUntilMs?: number;
}

export interface MemoryMatchExplanation {
  /** Normalized query terms found in the body. */
  matchedTerms?: readonly string[];
  /** Normalized query terms found in filename, description or type. */
  metadataMatches?: readonly string[];
}

export interface RankedMemoryDocument extends MemoryMatchExplanation {
  document: IndexedMemoryDocument;
  score: number;
}

export interface MemoryRecallResult extends MemoryManifestEntry, MemoryMatchExplanation {
  content: string;
  score: number;
  /** Original-byte revision hash supplied by a complete read, never a truncated prefix hash. */
  sourceHash?: string;
}

export interface MemoryCandidateScanStats {
  complete: boolean;
  truncated: boolean;
  /** Observed entries rejected as non-candidates, unsafe paths, links or duplicates. */
  rejected: number;
  failedDirectories: number;
  /** Directory listing attempts, including failed attempts. */
  scannedDirectories: number;
  processedEntries: number;
  /** Listings without an explicit truncation status cannot establish completeness. */
  unknownDirectories: number;
}

export interface MemoryCandidateScanResult {
  paths: string[];
  scan: MemoryCandidateScanStats;
}

export interface ProjectMemoryRecallHealth {
  /** Scan is incomplete/unknown or the corpus budget skipped candidates. */
  scanLimited: boolean;
  failedFileCount: number;
  expiredCount: number;
  /** Successfully read prefixes, including expired documents. */
  truncatedFileCount: number;
  /** Bytes in the current non-expired derived index, not the whole directory. */
  indexedBytes: number;
}

export interface ProjectMemoryRecallOutcome {
  attachment?: string;
  candidateCount: number;
  indexedCount: number;
  matchCount: number;
  results: readonly MemoryRecallResult[];
  health?: ProjectMemoryRecallHealth;
  scan?: MemoryCandidateScanStats;
}
