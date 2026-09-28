import {
  MEMORY_RECALL_BM25_B,
  MEMORY_RECALL_BM25_K1,
  MEMORY_RECALL_METADATA_BOOST_LIMIT,
  MEMORY_RECALL_METADATA_MATCH_BOOST,
} from "./constants.js";
import type { IndexedMemoryDocument, RankedMemoryDocument } from "./types.js";

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
