import type { Chunk, RankedChunk } from "./types";

/** Simple whitespace + unicode-friendly tokenizer */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9\u00c0-\u024f]+/i)
    .filter((t) => t.length > 1);
}

type Bm25CorpusIndex = {
  docs: string[][];
  termFrequencies: Map<string, number>[];
  documentLengths: number[];
  documentFrequency: Map<string, number>;
  postings: Map<string, number[]>;
  averageDocumentLength: number;
};

type LexicalDocument = {
  tokens: string[];
  termFrequency: Map<string, number>;
};

// A multi-notebook ask creates a new merged array (and new wrapper objects)
// on every request. Cache the expensive title+text tokenization by content so
// those requests do not repeatedly normalize and split the same PDF units.
// The bound keeps long-lived serverless workers from retaining an unbounded
// number of document token arrays.
const LEXICAL_DOCUMENT_CACHE_MAX = 2048;
const lexicalDocumentCache = new Map<string, LexicalDocument>();

function getLexicalDocument(chunk: Chunk): LexicalDocument {
  const key = `${chunk.title}\u0000${chunk.text}`;
  const cached = lexicalDocumentCache.get(key);
  if (cached) {
    lexicalDocumentCache.delete(key);
    lexicalDocumentCache.set(key, cached);
    return cached;
  }

  const tokens = tokenize(key);
  const termFrequency = new Map<string, number>();
  for (const term of tokens) {
    termFrequency.set(term, (termFrequency.get(term) || 0) + 1);
  }
  const entry = { tokens, termFrequency };
  lexicalDocumentCache.set(key, entry);
  while (lexicalDocumentCache.size > LEXICAL_DOCUMENT_CACHE_MAX) {
    const oldest = lexicalDocumentCache.keys().next().value as string | undefined;
    if (!oldest) break;
    lexicalDocumentCache.delete(oldest);
  }
  return entry;
}

// loadChunks keeps immutable corpus arrays hot between requests. Reuse the
// exact BM25 tokenization/DF statistics for those arrays without changing the
// scoring formula or ranking order.
const corpusIndexCache = new WeakMap<Chunk[], Bm25CorpusIndex>();

function getCorpusIndex(chunks: Chunk[]): Bm25CorpusIndex {
  const cached = corpusIndexCache.get(chunks);
  if (cached) return cached;

  const lexicalDocs = chunks.map(getLexicalDocument);
  const docs = lexicalDocs.map((doc) => doc.tokens);
  // Build per-document term frequencies once per immutable corpus. The old
  // hot path rebuilt one Map for every document on every query.
  const termFrequencies = lexicalDocs.map((doc) => doc.termFrequency);
  const documentFrequency = new Map<string, number>();
  const postings = new Map<string, number[]>();
  for (const [docIndex, doc] of docs.entries()) {
    const unique = new Set(doc);
    for (const term of unique) {
      documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
      const list = postings.get(term);
      if (list) list.push(docIndex);
      else postings.set(term, [docIndex]);
    }
  }

  const index = {
    docs,
    termFrequencies,
    documentLengths: docs.map((doc) => doc.length || 1),
    documentFrequency,
    postings,
    averageDocumentLength:
      docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(docs.length, 1),
  };
  corpusIndexCache.set(chunks, index);
  return index;
}

/**
 * Classic BM25 (Okapi) over in-memory chunks.
 * Pure TypeScript — safe for Vercel serverless cold starts.
 */
export function bm25Retrieve(
  query: string,
  chunks: Chunk[],
  topK = 20,
  k1 = 1.5,
  b = 0.75,
): RankedChunk[] {
  if (chunks.length === 0 || topK <= 0) return [];

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return chunks.slice(0, topK).map((c, i) => ({
      ...c,
      bm25Score: 0,
      bm25Rank: i + 1,
      finalScore: 0,
      finalRank: i + 1,
      citationId: i + 1,
    }));
  }

  // Include source titles: scientific chunks often put the entity/model name
  // in the title while the body starts mid-section after PDF extraction.
  const corpusIndex = getCorpusIndex(chunks);
  const {
    docs,
    termFrequencies,
    documentLengths,
    documentFrequency: df,
    postings,
  } = corpusIndex;
  const N = docs.length;
  const avgdl = corpusIndex.averageDocumentLength;

  const idf = (term: string) => {
    const n = df.get(term) || 0;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  };

  type Scored = { chunk: Chunk; score: number; index: number };
  const heap: Scored[] = [];

  // Keep only the best k items while scanning. The old implementation sorted
  // every scored document, which is unnecessary for retrievalTopK values such
  // as 40/80 and becomes expensive for large notebooks.
  const isBetter = (a: Scored, b: Scored) =>
    a.score > b.score || (a.score === b.score && a.index < b.index);
  const isWorse = (a: Scored, b: Scored) =>
    a.score < b.score || (a.score === b.score && a.index > b.index);
  const siftUp = (index: number) => {
    let i = index;
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (!isWorse(heap[i], heap[parent])) break;
      [heap[i], heap[parent]] = [heap[parent], heap[i]];
      i = parent;
    }
  };
  const siftDown = (index: number) => {
    let i = index;
    while (true) {
      const left = i * 2 + 1;
      const right = left + 1;
      let worst = i;
      if (left < heap.length && isWorse(heap[left], heap[worst])) worst = left;
      if (right < heap.length && isWorse(heap[right], heap[worst])) worst = right;
      if (worst === i) break;
      [heap[i], heap[worst]] = [heap[worst], heap[i]];
      i = worst;
    }
  };

  const candidateIds = new Set<number>();
  for (const term of new Set(queryTokens)) {
    for (const index of postings.get(term) || []) candidateIds.add(index);
  }
  // Preserve the old contract of returning up to topK rows even when fewer
  // documents contain the query terms: zero-score rows are only considered as
  // fallback candidates, never mixed into the hot scoring scan.
  if (candidateIds.size < topK) {
    for (let i = 0; i < chunks.length && candidateIds.size < topK; i++) {
      candidateIds.add(i);
    }
  }

  for (const i of candidateIds) {
    const chunk = chunks[i];
    const tfMap = termFrequencies[i];
    const dl = documentLengths[i];

    let score = 0;
    for (const term of queryTokens) {
      const tf = tfMap.get(term) || 0;
      if (!tf) continue;
      const denom = tf + k1 * (1 - b + b * (dl / avgdl));
      score += idf(term) * ((tf * (k1 + 1)) / denom);
    }
    const item = { chunk, score, index: i };
    if (heap.length < topK) {
      heap.push(item);
      siftUp(heap.length - 1);
    } else if (isBetter(item, heap[0])) {
      heap[0] = item;
      siftDown(0);
    }
  }

  heap.sort((a, b) => b.score - a.score || a.index - b.index);

  return heap.map((item, i) => ({
    chunkId: item.chunk.chunkId,
    documentId: item.chunk.documentId,
    title: item.chunk.title,
    url: item.chunk.url,
    text: item.chunk.text,
    chunkIndex: item.chunk.chunkIndex,
    bm25Score: item.score,
    bm25Rank: i + 1,
    finalScore: item.score,
    finalRank: i + 1,
    citationId: i + 1,
  }));
}
