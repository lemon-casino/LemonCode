import {
  MEMORY_RECALL_BM25_B,
  MEMORY_RECALL_BM25_K1,
  MEMORY_RECALL_METADATA_BOOST_LIMIT,
  MEMORY_RECALL_METADATA_MATCH_BOOST,
} from "./constants.js";
import type { IndexedMemoryDocument, RankedMemoryDocument } from "./types.js";
import type { MemoryRankingSignal } from "@lcode/contracts";

/** 明确反馈只调整已审核 reference 经验；约束/偏好/旧来源和无词法命中永不受实验影响。 */
export function applyMemoryRankingSignals(
  ranked: readonly RankedMemoryDocument[],
  signals: readonly MemoryRankingSignal[],
): RankedMemoryDocument[] {
  const byRevision = new Map(
    signals.map((signal) => [JSON.stringify([signal.fileName, signal.sourceHash]), signal]),
  );
  return ranked
    .map((entry) => {
      if (entry.document.type !== "reference" || !entry.document.sourceHash || entry.score <= 0)
        return entry;
      const signal = byRevision.get(
        JSON.stringify([entry.document.filename, entry.document.sourceHash]),
      );
      if (!signal?.eligible) return entry;
      const relevant = Math.max(0, Math.min(500, signal.relevant));
      const negative = Math.max(0, Math.min(500, signal.negative));
      if (!Number.isFinite(relevant) || !Number.isFinite(negative)) return entry;
      const factor = 1 + Math.max(-0.2, Math.min(0.2, (relevant - negative) * 0.05));
      return { ...entry, score: entry.score * factor };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        (left.document.filename < right.document.filename
          ? -1
          : left.document.filename > right.document.filename
            ? 1
            : 0),
    );
}

export function rankMemoryDocuments(input: {
  documents: readonly IndexedMemoryDocument[];
  queryTokens: readonly string[];
}): RankedMemoryDocument[] {
  if (input.documents.length === 0 || input.queryTokens.length === 0) return [];

  const queryTokens = [...new Set(input.queryTokens)];
  const documentFrequencies = new Map<string, number>();
  for (const document of input.documents) {
    for (const token of queryTokens) {
      if (document.termFrequencies.has(token)) {
        documentFrequencies.set(token, (documentFrequencies.get(token) ?? 0) + 1);
      }
    }
  }

  const averageDocumentLength = Math.max(
    1,
    input.documents.reduce((total, document) => total + document.tokenCount, 0) /
      input.documents.length,
  );
  const ranked = input.documents
    .map((document) => ({
      document,
      matchedTerms: queryTokens.filter((token) => document.termFrequencies.has(token)),
      metadataMatches: queryTokens.filter((token) => document.metadataTokens.has(token)),
      score:
        calculateBm25Score({
          averageDocumentLength,
          document,
          documentCount: input.documents.length,
          documentFrequencies,
          queryTokens,
        }) + calculateMetadataBoost(document, queryTokens),
    }))
    .filter((entry) => entry.score > 0);

  ranked.sort((left, right) => {
    const scoreDifference = right.score - left.score;
    if (scoreDifference !== 0) return scoreDifference;
    if (left.document.filename === right.document.filename) return 0;
    return left.document.filename < right.document.filename ? -1 : 1;
  });
  return ranked;
}

function calculateBm25Score(input: {
  averageDocumentLength: number;
  document: IndexedMemoryDocument;
  documentCount: number;
  documentFrequencies: ReadonlyMap<string, number>;
  queryTokens: readonly string[];
}): number {
  let score = 0;
  for (const token of input.queryTokens) {
    const termFrequency = input.document.termFrequencies.get(token) ?? 0;
    if (termFrequency === 0) continue;
    const documentFrequency = input.documentFrequencies.get(token) ?? 0;
    const inverseDocumentFrequency = Math.log(
      1 + (input.documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5),
    );
    const lengthNormalization =
      1 -
      MEMORY_RECALL_BM25_B +
      MEMORY_RECALL_BM25_B * (input.document.tokenCount / input.averageDocumentLength);
    score +=
      inverseDocumentFrequency *
      ((termFrequency * (MEMORY_RECALL_BM25_K1 + 1)) /
        (termFrequency + MEMORY_RECALL_BM25_K1 * lengthNormalization));
  }
  return score;
}

function calculateMetadataBoost(
  document: IndexedMemoryDocument,
  queryTokens: readonly string[],
): number {
  const matchCount = queryTokens.filter((token) => document.metadataTokens.has(token)).length;
  return Math.min(
    MEMORY_RECALL_METADATA_BOOST_LIMIT,
    matchCount * MEMORY_RECALL_METADATA_MATCH_BOOST,
  );
}
