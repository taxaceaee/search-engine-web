import { getConfig, IR_DEFAULTS } from "@/lib/config";
import { bm25Retrieve, tokenize } from "./bm25";
import { cosineSimilarity, embedTexts } from "./embedding";
import { sgafRetrieve } from "./sgaf";
import type { Chunk, ChunkWithEmbedding, RankedChunk } from "./types";

export type HybridRetrievalDiagnostics = {
  mode:
    | "bm25"
    | "adaptive_rrf"
    | "sgaf"
    | "legacy_rrf_ce"
    | "bm25_fallback";
  denseUsed: boolean;
  denseSkippedReason?: string;
  embeddingProvider?: string;
  embeddingModel?: string;
  embeddingMs?: number;
  embeddingInputCount?: number;
  bm25Ms?: number;
  denseMs?: number;
  fusionMs?: number;
  bm25Weight?: number;
  b5Mode?: "specialist_safe" | "generalist_fallback";
  b5ShiftScore?: number;
  specialistModel?: string;
  p3Applied?: boolean;
};

export type HybridRetrievalResult = {
  results: RankedChunk[];
  diagnostics: HybridRetrievalDiagnostics;
};

function porterStem(word: string) {
  let w = word.toLowerCase();
  if (w.endsWith("ies") && w.length > 3) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("es") && w.length > 3) w = w.slice(0, -2);
  else if (w.endsWith("s") && !w.endsWith("ss") && w.length > 2) w = w.slice(0, -1);
  if (w.endsWith("ing") && w.length > 5) w = w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 4) w = w.slice(0, -2);
  if (w.endsWith("tion") && w.length > 5) w = `${w.slice(0, -4)}t`;
  return w;
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function buildIdfVocabulary(chunks: Chunk[], minDf = 1) {
  const df = new Map<string, number>();
  for (const chunk of chunks) {
    const terms = new Set(
      tokenize(chunk.text)
        .map(porterStem)
        .filter((t) => t.length >= 3),
    );
    for (const term of terms) df.set(term, (df.get(term) || 0) + 1);
  }

  const total = chunks.length;
  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    if (count >= minDf) idf.set(term, Math.log(total / count));
  }
  return idf;
}

type AdaptiveCorpusStats = {
  idf: Map<string, number>;
  medianIdf: number;
};

const adaptiveCorpusStatsCache = new WeakMap<Chunk[], AdaptiveCorpusStats>();

function getAdaptiveCorpusStats(chunks: Chunk[]): AdaptiveCorpusStats {
  const cached = adaptiveCorpusStatsCache.get(chunks);
  if (cached) return cached;
  const idf = buildIdfVocabulary(chunks);
  const stats = { idf, medianIdf: median([...idf.values()]) };
  adaptiveCorpusStatsCache.set(chunks, stats);
  return stats;
}

function queryMeanIdf(query: string, idf: Map<string, number>, fallback: number) {
  const stems = tokenize(query)
    .map(porterStem)
    .filter((t) => t.length >= 3);
  if (stems.length === 0) return fallback;
  return stems.reduce((sum, term) => sum + (idf.get(term) ?? fallback), 0) / stems.length;
}

function adaptiveBm25Weight(query: string, chunks: Chunk[]) {
  const { idf, medianIdf: fallback } = getAdaptiveCorpusStats(chunks);
  const meanIdf = queryMeanIdf(query, idf, fallback);
  const logit = IR_DEFAULTS.adaptiveRrfScale * (meanIdf - fallback);
  const sigmoid = 1 / (1 + Math.exp(-logit));
  return (
    IR_DEFAULTS.adaptiveRrfMinBm25Weight +
    sigmoid *
      (IR_DEFAULTS.adaptiveRrfMaxBm25Weight -
        IR_DEFAULTS.adaptiveRrfMinBm25Weight)
  );
}

function denseRetrieve(
  chunks: ChunkWithEmbedding[],
  queryEmbedding: number[],
  topK: number,
) {
  return chunks
    .map((chunk) => ({
      chunk,
      score: chunk.embedding
        ? cosineSimilarity(queryEmbedding, chunk.embedding)
        : Number.NEGATIVE_INFINITY,
    }))
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((item, i) => ({ ...item, rank: i + 1 }));
}

function formatQueryForEmbedding(query: string) {
  return `Represent this sentence for searching relevant passages: ${query}`;
}

function safeRankedChunk(
  chunk: Chunk,
  scores: {
    bm25Score: number;
    bm25Rank: number;
    denseScore?: number;
    denseRank?: number;
    finalScore: number;
    finalRank: number;
    retrievalMode: RankedChunk["retrievalMode"];
    bm25Weight?: number;
    crossEncoderScore?: number;
  },
): RankedChunk {
  return {
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    title: chunk.title,
    url: chunk.url,
    text: chunk.text,
    chunkIndex: chunk.chunkIndex,
    bm25Score: scores.bm25Score,
    bm25Rank: scores.bm25Rank,
    denseScore: scores.denseScore,
    denseRank: scores.denseRank,
    finalScore: scores.finalScore,
    finalRank: scores.finalRank,
    citationId: scores.finalRank,
    retrievalMode: scores.retrievalMode,
    bm25Weight: scores.bm25Weight,
    crossEncoderScore: scores.crossEncoderScore,
  };
}

function bm25Fallback(
  query: string,
  chunks: Chunk[],
  topK: number,
  reason?: string,
): HybridRetrievalResult {
  const bm25Start = performance.now();
  const results = bm25Retrieve(query, chunks, topK).map((r) => ({
    ...r,
    retrievalMode: (reason ? "bm25_fallback" : "bm25") as RankedChunk["retrievalMode"],
  }));
  const bm25Ms = Math.round(performance.now() - bm25Start);
  return {
    results,
    diagnostics: {
      mode: reason ? "bm25_fallback" : "bm25",
      denseUsed: false,
      denseSkippedReason: reason,
      bm25Ms,
      fusionMs: 0,
      denseMs: 0,
    },
  };
}

export async function retrieveEvidence(
  query: string,
  chunks: ChunkWithEmbedding[],
  topK: number,
  mode: "bm25" | "adaptive_rrf" | "sgaf" | "legacy_rrf_ce" = "bm25",
  options?: { signal?: AbortSignal },
): Promise<HybridRetrievalResult> {
  if (mode === "bm25") return bm25Fallback(query, chunks, topK);
  if (mode === "legacy_rrf_ce") {
    return legacyRrfCeRetrieve(query, chunks, topK, options);
  }
  if (mode === "sgaf") {
    const cfg = getConfig();
    const generalistModel = cfg.EMBEDDING_MODEL;
    const specialistModel =
      cfg.SPECIALIST_EMBEDDING_MODEL?.trim() || generalistModel;
    try {
      const sgaf = await sgafRetrieve(
        query,
        chunks,
        topK,
        async (texts, model) =>
          (
            await embedTexts(texts, {
              model,
              signal: options?.signal,
              timeoutMs: 5_000,
            })
          ).embeddings,
        specialistModel,
        generalistModel,
      );
      return {
        results: sgaf.results,
        diagnostics: {
          ...sgaf.diagnostics,
          embeddingProvider: cfg.EMBEDDING_PROVIDER,
          embeddingModel: generalistModel,
          embeddingInputCount: 2,
        },
      };
    } catch (err) {
      return bm25Fallback(
        query,
        chunks,
        topK,
        err instanceof Error ? `SGAF failed: ${err.message}` : "SGAF failed",
      );
    }
  }
  if (chunks.length === 0) {
    return {
      results: [],
      diagnostics: { mode: "adaptive_rrf", denseUsed: false },
    };
  }

  const bm25TopK = Math.max(topK, IR_DEFAULTS.denseTopK, IR_DEFAULTS.maxDenseChunks);
  // Query embedding and lexical ranking are independent on the pre-indexed
  // hot path. Start the network request before BM25 so retrieval pays the
  // larger of the two costs rather than their sum.
  const allChunksEmbedded = chunks.every(
    (chunk) => Boolean(chunk.embedding && chunk.embedding.length > 0),
  );
  const queryEmbeddingPromise = allChunksEmbedded
    ? embedTexts([formatQueryForEmbedding(query)], {
        signal: options?.signal,
        timeoutMs: 5_000,
      })
    : null;
  const bm25Start = performance.now();
  const bm25All = bm25Retrieve(query, chunks, bm25TopK);
  const bm25Ms = Math.round(performance.now() - bm25Start);
  const selectedIds = new Set(
    bm25All.slice(0, IR_DEFAULTS.maxDenseChunks).map((hit) => hit.chunkId),
  );
  const denseInputChunks =
    chunks.length > IR_DEFAULTS.maxDenseChunks
      ? chunks.filter((chunk) => selectedIds.has(chunk.chunkId))
      : chunks;
  const bm25 = bm25All.filter((hit) => selectedIds.has(hit.chunkId));
  const byId = new Map(denseInputChunks.map((chunk) => [chunk.chunkId, chunk]));

  const start = performance.now();
  try {
    const missing = denseInputChunks.filter(
      (chunk) => !chunk.embedding || chunk.embedding.length === 0,
    );
    let embeddingProvider = "";
    let embeddingModel = "";
    let embeddedChunks: ChunkWithEmbedding[] = denseInputChunks;

    // Hot path: pre-indexed corpus → embed query only
    // Cold path: only opt into live corpus embedding for an explicitly small
    // missing-vector set. Raw-source notebooks otherwise fall back to BM25
    // immediately instead of waiting for a provider timeout on every query.
    if (missing.length > 0) {
      const missingChars = missing.reduce((sum, chunk) => sum + chunk.text.length, 0);
      if (
        missing.length > IR_DEFAULTS.maxLiveDenseMissing ||
        missingChars > IR_DEFAULTS.maxLiveDenseChars
      ) {
        return bm25Fallback(
          query,
          chunks,
          topK,
          `Dense retrieval skipped: ${missing.length} units / ${missingChars} chars are not pre-indexed`,
        );
      }
      const response = await embedTexts(
        [formatQueryForEmbedding(query), ...missing.map((chunk) => chunk.text)],
        { signal: options?.signal, timeoutMs: 5_000 },
      );
      const [queryEmbedding, ...missingVectors] = response.embeddings;
      const byMissing = new Map(
        missing.map((chunk, i) => [chunk.chunkId, missingVectors[i]] as const),
      );
      embeddedChunks = denseInputChunks.map((chunk) => {
        const filled = byMissing.get(chunk.chunkId);
        if (filled) {
          return {
            ...chunk,
            embedding: filled,
            embeddingModel: response.model,
          };
        }
        return chunk;
      });
      embeddingProvider = response.provider;
      embeddingModel = response.model;

      return fuseRuns({
        query,
        chunks: embeddedChunks,
        queryEmbedding,
        bm25,
        byId: new Map(embeddedChunks.map((chunk) => [chunk.chunkId, chunk])),
        topK,
        embeddingMs: Math.round(performance.now() - start),
        embeddingInputCount: response.embeddings.length,
        bm25Ms,
        embeddingProvider,
        embeddingModel,
      });
    }

    const response = await (queryEmbeddingPromise || embedTexts(
      [formatQueryForEmbedding(query)],
      { signal: options?.signal, timeoutMs: 5_000 },
    ));
    embeddingProvider = response.provider;
    embeddingModel = response.model;
    return fuseRuns({
      query,
      chunks: embeddedChunks,
      queryEmbedding: response.embeddings[0],
      bm25,
      byId,
      topK,
      embeddingMs: Math.round(performance.now() - start),
      embeddingInputCount: response.embeddings.length,
      bm25Ms,
      embeddingProvider,
      embeddingModel,
    });
  } catch (err) {
    const fallback = bm25Fallback(
      query,
      chunks,
      topK,
      err instanceof Error ? err.message : "Dense retrieval failed",
    );
    return {
      ...fallback,
      diagnostics: {
        ...fallback.diagnostics,
        bm25Ms: fallback.diagnostics.bm25Ms ?? bm25Ms,
      },
    };
  }
}

type LegacyRerankResponse = {
  scores?: unknown;
  results?: unknown;
};

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function legacyRrfK(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
}

/**
 * Reimplementation of the legacy branch's BM25 + SciNCL + classic RRF path.
 * Existing stored vectors are intentionally ignored because they may have
 * been generated by a different embedding model.
 */
async function legacyRrfCeRetrieve(
  query: string,
  chunks: ChunkWithEmbedding[],
  topK: number,
  options?: { signal?: AbortSignal },
): Promise<HybridRetrievalResult> {
  const cfg = getConfig();
  if (chunks.length === 0) {
    return { results: [], diagnostics: { mode: "legacy_rrf_ce", denseUsed: false } };
  }

  const bm25Start = performance.now();
  const bm25 = bm25Retrieve(
    query,
    chunks,
    Math.max(topK, IR_DEFAULTS.denseTopK, IR_DEFAULTS.maxDenseChunks),
  );
  const bm25Ms = Math.round(performance.now() - bm25Start);
  const bm25Ids = new Set(bm25.map((hit) => hit.chunkId));
  const denseInput = chunks.length > IR_DEFAULTS.maxDenseChunks
    ? chunks.filter((chunk) => bm25Ids.has(chunk.chunkId))
    : chunks;
  const byId = new Map(denseInput.map((chunk) => [chunk.chunkId, chunk]));

  const embedStart = performance.now();
  try {
    const embedding = await embedTexts(
      [formatQueryForEmbedding(query), ...denseInput.map((chunk) => chunk.text)],
      {
        model: cfg.LEGACY_DENSE_MODEL,
        signal: options?.signal,
        timeoutMs: 5_000,
      },
    );
    const [queryEmbedding, ...chunkEmbeddings] = embedding.embeddings;
    const denseStart = performance.now();
    const dense = denseInput
      .map((chunk, index) => ({
        chunk,
        score: cosineSimilarity(queryEmbedding, chunkEmbeddings[index] || []),
      }))
      .sort((a, b) => b.score - a.score)
      .map((hit, index) => ({ ...hit, rank: index + 1 }));
    const denseMs = Math.round(performance.now() - denseStart);

    const fusionStart = performance.now();
    const k = legacyRrfK(cfg.LEGACY_RRF_K);
    const bm25Map = new Map(bm25.map((hit) => [hit.chunkId, hit]));
    const denseMap = new Map(dense.map((hit) => [hit.chunk.chunkId, hit]));
    const scores = new Map<string, number>();
    for (const hit of bm25) {
      scores.set(hit.chunkId, (scores.get(hit.chunkId) || 0) + 1 / (k + hit.bm25Rank));
    }
    for (const hit of dense) {
      scores.set(
        hit.chunk.chunkId,
        (scores.get(hit.chunk.chunkId) || 0) + 1 / (k + hit.rank),
      );
    }

    const rrf = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([chunkId, finalScore], index) => {
        const chunk = byId.get(chunkId);
        if (!chunk) return null;
        const lexical = bm25Map.get(chunkId);
        const semantic = denseMap.get(chunkId);
        return safeRankedChunk(chunk, {
          bm25Score: lexical?.bm25Score ?? 0,
          bm25Rank: lexical?.bm25Rank ?? 0,
          denseScore: semantic?.score,
          denseRank: semantic?.rank,
          finalScore,
          finalRank: index + 1,
          retrievalMode: "legacy_rrf_ce",
        });
      })
      .filter((hit): hit is RankedChunk => Boolean(hit));
    const fusionMs = Math.round(performance.now() - fusionStart);

    const reranked = await rerankLegacyCandidates(query, rrf, cfg);
    const embeddingMs = Math.round(performance.now() - embedStart);
    return {
      results: reranked.results.slice(0, topK),
      diagnostics: {
        mode: "legacy_rrf_ce",
        denseUsed: true,
        denseSkippedReason: reranked.reason,
        embeddingProvider: embedding.provider,
        embeddingModel: embedding.model,
        embeddingMs,
        embeddingInputCount: embedding.embeddings.length,
        bm25Ms,
        denseMs,
        fusionMs,
      },
    };
  } catch (err) {
    const fallback = bm25Fallback(
      query,
      chunks,
      topK,
      err instanceof Error ? `Legacy dense retrieval failed: ${err.message}` : "Legacy dense retrieval failed",
    );
    return {
      ...fallback,
      diagnostics: {
        ...fallback.diagnostics,
        mode: "legacy_rrf_ce",
        bm25Ms,
        denseSkippedReason: fallback.diagnostics.denseSkippedReason,
      },
    };
  }
}

async function rerankLegacyCandidates(
  query: string,
  candidates: RankedChunk[],
  cfg: ReturnType<typeof getConfig>,
): Promise<{ results: RankedChunk[]; reason?: string }> {
  const url = cfg.LEGACY_RERANKER_URL;
  if (!url || candidates.length === 0) {
    return {
      results: candidates,
      reason: "Cross-Encoder is not configured; showing SciNCL + classic RRF",
    };
  }

  const limit = Math.min(candidates.length, 20);
  const target = candidates.slice(0, limit);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.LEGACY_RERANKER_MODEL,
        query,
        documents: target.map((candidate) => ({
          id: candidate.chunkId,
          text: candidate.text,
        })),
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Cross-Encoder HTTP ${response.status}`);
    const payload = (await response.json()) as LegacyRerankResponse;
    const scores = Array.isArray(payload.scores)
      ? payload.scores.filter(finiteNumber)
      : Array.isArray(payload.results)
        ? (payload.results as Array<{ id?: unknown; score?: unknown }>)
            .map((item) => ({ id: item.id, score: item.score }))
            .filter((item) => typeof item.id === "string" && finiteNumber(item.score))
        : [];
    if (scores.length !== target.length) {
      throw new Error("Cross-Encoder response must return one score per document");
    }

    const scoreById = new Map<string, number>();
    if (scores.length > 0 && typeof scores[0] === "number") {
      (scores as number[]).forEach((score, index) => scoreById.set(target[index].chunkId, score));
    } else {
      (scores as Array<{ id: string; score: number }>).forEach((item) => scoreById.set(item.id, item.score));
    }
    const rerankedTarget = target
      .map((candidate) => ({ ...candidate, crossEncoderScore: scoreById.get(candidate.chunkId) }))
      .sort((a, b) => (b.crossEncoderScore ?? -Infinity) - (a.crossEncoderScore ?? -Infinity));
    const rest = candidates.slice(limit);
    return {
      results: [...rerankedTarget, ...rest].map((candidate, index) => ({
        ...candidate,
        finalRank: index + 1,
        citationId: index + 1,
      })),
    };
  } catch (err) {
    return {
      results: candidates,
      reason: `Cross-Encoder unavailable; showing SciNCL + classic RRF (${err instanceof Error ? err.message : "request failed"})`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function fuseRuns(params: {
  query: string;
  chunks: ChunkWithEmbedding[];
  queryEmbedding: number[];
  bm25: RankedChunk[];
  byId: Map<string, ChunkWithEmbedding>;
  topK: number;
  embeddingMs: number;
  embeddingInputCount: number;
  bm25Ms: number;
  embeddingProvider: string;
  embeddingModel: string;
}): HybridRetrievalResult {
  const denseStart = performance.now();
  const dense = denseRetrieve(
    params.chunks,
    params.queryEmbedding,
    Math.max(params.topK, IR_DEFAULTS.denseTopK),
  );
  const denseMs = Math.round(performance.now() - denseStart);
  if (dense.length === 0) {
    return bm25Fallback(
      params.query,
      params.chunks,
      params.topK,
      "No dense embeddings available",
    );
  }

  const fusionStart = performance.now();
  const bm25Weight = adaptiveBm25Weight(params.query, params.chunks);
  const scores = new Map<string, number>();
  const bm25Map = new Map(params.bm25.map((hit) => [hit.chunkId, hit]));
  const denseMap = new Map(dense.map((hit) => [hit.chunk.chunkId, hit]));

  for (const hit of params.bm25) {
    scores.set(
      hit.chunkId,
      (scores.get(hit.chunkId) || 0) +
        bm25Weight / (IR_DEFAULTS.rrfK + hit.bm25Rank),
    );
  }
  for (const hit of dense) {
    scores.set(
      hit.chunk.chunkId,
      (scores.get(hit.chunk.chunkId) || 0) + 1 / (IR_DEFAULTS.rrfK + hit.rank),
    );
  }

  const results = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, params.topK)
    .map(([chunkId, finalScore], i) => {
      const chunk = params.byId.get(chunkId);
      if (!chunk) return null;
      const bm25Hit = bm25Map.get(chunkId);
      const denseHit = denseMap.get(chunkId);
      return safeRankedChunk(chunk, {
        bm25Score: bm25Hit?.bm25Score ?? 0,
        bm25Rank: bm25Hit?.bm25Rank ?? 0,
        denseScore: denseHit?.score,
        denseRank: denseHit?.rank,
        finalScore,
        finalRank: i + 1,
        retrievalMode: "adaptive_rrf",
        bm25Weight,
      });
    })
    .filter((r): r is RankedChunk => Boolean(r));
  const fusionMs = Math.round(performance.now() - fusionStart);

  return {
    results,
    diagnostics: {
      mode: "adaptive_rrf",
      denseUsed: true,
      embeddingProvider: params.embeddingProvider,
      embeddingModel: params.embeddingModel,
      embeddingMs: params.embeddingMs,
      embeddingInputCount: params.embeddingInputCount,
      bm25Ms: params.bm25Ms,
      denseMs,
      fusionMs,
      bm25Weight,
    },
  };
}
