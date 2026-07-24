/**
 * Pure visualization models for teaching IR pipelines.
 * UI components render these; unit tests drive these functions only.
 */
import type {
  Metrics,
  RankedChunk,
  RankedDocument,
  Timing,
} from "./types";
import { absoluteRankStrength } from "./document-rank";
import { corpusTimingMs } from "./timing";

export type StageVizId =
  | "corpus"
  | "query"
  | "rank"
  | "bm25"
  | "embedding"
  | "fusion"
  | "pack"
  | "generate"
  | "total";

export type StageVizRow = {
  id: StageVizId;
  label: string;
  /** Educational copy for demos / teaching */
  explanation: string;
  ms: number | null;
  /** Whether this stage ran, was skipped, or never started */
  outcome: "ran" | "skipped" | "idle" | "failed";
  detail?: string;
};

export type WaterfallBar = {
  id: StageVizId;
  label: string;
  ms: number;
  /** Share of total wall (0–1) for bar width */
  fraction: number;
  offsetFraction: number;
  color: "primary" | "accent" | "muted" | "success" | "warn";
};

export type RankTransitionRow = {
  chunkId: string;
  documentId: string;
  title: string;
  bm25Rank: number | null;
  denseRank: number | null;
  finalRank: number;
  bm25Score: number;
  denseScore: number | null;
  finalScore: number;
  /** Positive = improved rank from BM25 to final (lower rank number is better) */
  rankDeltaFromBm25: number | null;
  snippet: string;
};

export type DocumentScoreBar = {
  documentId: string;
  title: string;
  finalRank: number;
  finalScore: number;
  /** Relative score (score/max) for UI bars */
  relativeScore: number;
  /** @deprecated use relativeScore */
  confidence: number;
  /** Bar width 0–1 relative to max score in the set */
  scoreFraction: number;
  confFraction: number;
  bm25Best?: number;
  denseBest?: number;
  chunkHits: number;
};

export type CandidateCompareRow = {
  chunkId: string;
  documentId: string;
  title: string;
  /** Preview of the unit text so identical source titles stay distinguishable. */
  snippet: string;
  finalRank: number;
  inPacked: boolean;
  bm25Rank: number;
  denseRank: number | null;
  finalScore: number;
};

const STAGE_COPY: Record<
  Exclude<StageVizId, "total">,
  { label: string; explanation: string }
> = {
  corpus: {
    label: "Corpus load",
    explanation:
      "Load retrieval units and assemble selected datasets before ranking. This cost is measured outside the ranking pipeline so slow database reads remain visible.",
  },
  query: {
    label: "Query prep",
    explanation:
      "Normalize/trim the user query before retrieval. Multi-turn expansion would appear here on web search; dataset search uses the query as typed.",
  },
  rank: {
    label: "Retrieval / rank",
    explanation:
      "Wall-clock retrieval and document ranking time, excluding context packing. BM25, embedding and fusion timings are diagnostic sub-stages and may overlap.",
  },
  bm25: {
    label: "Lexical BM25",
    explanation:
      "Okapi BM25 scores every retrieval unit by term frequency and inverse document frequency. For raw corpora each unit is a full stored source (not a pre-indexed chunk). High scores mean strong keyword overlap with the query.",
  },
  embedding: {
    label: "Dense embedding (query-time)",
    explanation:
      "When hybrid mode is on, embed the query (and missing unit vectors) at query time, then rank by cosine similarity. Upload does not store embeddings.",
  },
  fusion: {
    label: "Hybrid fusion (RRF)",
    explanation:
      "Rank fusion merges BM25 and dense rank lists. Adaptive mode applies a query-dependent BM25 weight; legacy mode uses classic Reciprocal Rank Fusion (Cormack et al.), k=60. This is not a cross-encoder reranker.",
  },
  pack: {
    label: "Context pack",
    explanation:
      "Select a small, diverse subset of top retrieval hits for the LLM (limit per source) so generation does not over-focus on one document.",
  },
  generate: {
    label: "Generate answer",
    explanation:
      "Optional LLM step: stream a cited answer using only packed evidence. IR ranking above remains the primary retrieval result.",
  },
};

/**
 * Build educational stage rows from Timing + Metrics after a dataset run.
 */
export function buildStageTimeline(
  timing: Timing | null | undefined,
  metrics: Metrics | null | undefined,
): StageVizRow[] {
  if (!timing && !metrics) return [];

  const mode = metrics?.retrievalMode;
  const denseUsed = Boolean(metrics?.denseUsed);
  const denseSkip = metrics?.denseSkippedReason;
  const llmUsed = metrics?.llmUsed;
  const llmSkip = metrics?.llmSkippedReason;

  const rows: StageVizRow[] = [
    {
      id: "query",
      label: STAGE_COPY.query.label,
      explanation: STAGE_COPY.query.explanation,
      ms: timing?.queryProcessMs ?? null,
      outcome: timing ? "ran" : "idle",
      detail: "queryProcessMs",
    },
    {
      id: "bm25",
      label: STAGE_COPY.bm25.label,
      explanation: STAGE_COPY.bm25.explanation,
      ms: timing?.bm25Ms ?? null,
      outcome: timing?.bm25Ms != null || mode ? "ran" : "idle",
      detail:
        mode === "bm25" || mode === "bm25_fallback"
          ? `Mode ${mode}`
          : "Lexical candidate generation",
    },
    {
      id: "embedding",
      label: STAGE_COPY.embedding.label,
      explanation: STAGE_COPY.embedding.explanation,
      ms: timing?.embeddingMs ?? null,
      outcome: denseUsed
        ? "ran"
        : denseSkip || mode === "bm25"
          ? "skipped"
          : timing?.embeddingMs != null
            ? "ran"
            : "idle",
      detail: denseUsed
        ? [metrics?.embeddingProvider, metrics?.embeddingModel]
            .filter(Boolean)
            .join(" · ") || "Dense used"
        : denseSkip ||
          (mode === "bm25" ? "BM25-only mode — dense not requested" : undefined),
    },
    {
      id: "fusion",
      label: STAGE_COPY.fusion.label,
      explanation: STAGE_COPY.fusion.explanation,
      ms: timing?.fusionMs ?? null,
      outcome:
        mode === "adaptive_rrf" || mode === "legacy_rrf_ce" || mode === "sgaf"
          ? "ran"
          : mode === "bm25" || mode === "bm25_fallback"
            ? "skipped"
            : "idle",
      detail:
        mode === "adaptive_rrf" || mode === "legacy_rrf_ce" || mode === "sgaf"
          ? mode === "legacy_rrf_ce"
            ? "SciNCL · classic RRF · k=60 · optional Cross-Encoder"
            : mode === "sgaf"
              ? "SGAF B5+P3 · specialist/generalist fusion"
              : "Adaptive RRF · query-dependent BM25 weight · k=60"
          : mode
            ? `No RRF (${mode})`
            : undefined,
    },
    {
      id: "pack",
      label: STAGE_COPY.pack.label,
      explanation: STAGE_COPY.pack.explanation,
      ms: timing?.packMs ?? null,
      outcome:
        timing?.packMs != null || metrics?.contextCount != null
          ? "ran"
          : "idle",
      detail:
        metrics?.contextCount != null
          ? `${metrics.contextCount} chunks · ${metrics.sourcesUsed ?? "?"} sources`
          : undefined,
    },
    {
      id: "generate",
      label: STAGE_COPY.generate.label,
      explanation: STAGE_COPY.generate.explanation,
      ms: timing?.generateMs ?? null,
      outcome: llmUsed
        ? "ran"
        : llmSkip
          ? llmSkip === "generateAnswer=false"
            ? "skipped"
            : "failed"
          : "idle",
      detail: llmUsed
        ? timing?.ttftMs != null
          ? `TTFT ${Math.round(timing.ttftMs)}ms`
          : "LLM used"
        : llmSkip,
    },
  ];

  const corpusMs =
    (timing?.notebookLookupMs ?? 0) +
    (timing?.corpusLoadMs ?? 0) +
    (timing?.corpusMergeMs ?? 0);
  if (
    timing?.notebookLookupMs != null ||
    timing?.corpusLoadMs != null ||
    timing?.corpusMergeMs != null
  ) {
    rows.unshift({
      id: "corpus",
      label: STAGE_COPY.corpus.label,
      explanation: STAGE_COPY.corpus.explanation,
      ms: corpusMs,
      outcome: "ran",
      detail: "notebook lookup + corpus load + merge",
    });
  }

  return rows;
}

/**
 * Sequential top-level waterfall bars. Component timings are intentionally
 * not rendered as adjacent bars because BM25 and embedding may overlap.
 */
export function buildTimingWaterfall(
  timing: Timing | null | undefined,
  metrics?: Metrics | null,
): WaterfallBar[] {
  if (!timing) return [];

  const stages: {
    id: StageVizId;
    label: string;
    ms: number;
    color: WaterfallBar["color"];
    include: boolean;
  }[] = [
    {
      id: "query",
      label: "Query",
      ms: timing.queryProcessMs ?? 0,
      color: "muted",
      include: (timing.queryProcessMs ?? 0) > 0 || true,
    },
    {
      id: "rank",
      label: "Rank",
      ms: timing.rankMs ?? timing.retrieveMs ?? 0,
      color: "primary",
      include: true,
    },
    {
      id: "pack",
      label: "Pack",
      ms: timing.packMs ?? 0,
      color: "success",
      include: true,
    },
    {
      id: "generate",
      label: "Generate",
      ms: timing.generateMs ?? 0,
      color: "warn",
      include: Boolean(metrics?.llmUsed) || (timing.generateMs ?? 0) > 0,
    },
  ];

  const corpusMs = corpusTimingMs(timing);
  if (
    timing.notebookLookupMs != null ||
    timing.corpusLoadMs != null ||
    timing.corpusMergeMs != null
  ) {
    stages.unshift({
      id: "corpus",
      label: "Corpus",
      ms: corpusMs,
      color: "muted",
      include: true,
    });
  }

  const active = stages.filter((s) => s.include && (s.ms > 0 || s.id === "rank" || s.id === "pack" || s.id === "query"));
  const namedMs = active.reduce((a, s) => a + Math.max(0, s.ms), 0);
  const total = Math.max(timing.totalMs ?? 0, namedMs, 1);
  const overheadMs = Math.max(0, total - namedMs);
  if (overheadMs > 0) {
    active.push({
      id: "total",
      label: "Other",
      ms: overheadMs,
      color: "muted",
      include: true,
    });
  }

  let offset = 0;
  return active.map((s) => {
    const ms = Math.max(0, s.ms);
    const bar: WaterfallBar = {
      id: s.id,
      label: s.label,
      ms,
      fraction: ms / total,
      offsetFraction: offset / total,
      color: s.color,
    };
    offset += ms;
    return bar;
  });
}

/**
 * Rank transition table: how each chunk moved from BM25 (and dense) to final.
 */
export function buildRankTransitions(
  rankedChunks: RankedChunk[],
  limit = 15,
): RankTransitionRow[] {
  return rankedChunks.slice(0, limit).map((c) => {
    const bm25Rank = c.bm25Rank > 0 ? c.bm25Rank : null;
    const denseRank =
      c.denseRank != null && c.denseRank > 0 ? c.denseRank : null;
    const finalRank = c.finalRank;
    const finalScore = Number.isFinite(c.finalScore)
      ? (c.finalScore as number)
      : c.bm25Score;
    return {
      chunkId: c.chunkId,
      documentId: c.documentId,
      title: c.title,
      bm25Rank,
      denseRank,
      finalRank,
      bm25Score: c.bm25Score,
      denseScore:
        c.denseScore != null && Number.isFinite(c.denseScore)
          ? c.denseScore
          : null,
      finalScore,
      rankDeltaFromBm25:
        bm25Rank != null ? bm25Rank - finalRank : null,
      snippet: (c.text || "").replace(/\s+/g, " ").trim().slice(0, 180),
    };
  });
}

/**
 * Horizontal score / relative-score series for top documents.
 */
export function buildDocumentScoreSeries(
  documents: RankedDocument[],
  retrievalMode?: Metrics["retrievalMode"],
): DocumentScoreBar[] {
  if (!documents.length) return [];
  // The API normally aggregates one row per document. Keep this view
  // defensive because older/history payloads can contain repeated documentId
  // entries; never render the same source twice in the score panel.
  const uniqueDocuments = Array.from(
    documents.reduce((byId, document) => {
      const previous = byId.get(document.documentId);
      if (!previous || document.finalScore > previous.finalScore) {
        byId.set(document.documentId, document);
      }
      return byId;
    }, new Map<string, RankedDocument>()).values(),
  ).sort((a, b) => a.finalRank - b.finalRank);
  const maxScore = Math.max(
    ...uniqueDocuments.map((d) =>
      Number.isFinite(d.finalScore) ? d.finalScore : 0,
    ),
    1e-9,
  );
  const isRrf =
    retrievalMode === "adaptive_rrf" || retrievalMode === "legacy_rrf_ce";
  return uniqueDocuments.map((d) => {
    const relativeScore = d.relativeScore ?? d.confidence ?? 0;
    return {
      documentId: d.documentId,
      title: d.title,
      finalRank: d.finalRank,
      finalScore: d.finalScore,
      relativeScore,
      confidence: relativeScore,
      // RRF score and relative score are different views:
      // - RRF strength is measured against the dual-list RRF ceiling.
      // - Relative score is measured against the top result in this run.
      // Keeping separate denominators prevents two visually identical bars.
      scoreFraction: isRrf
        ? absoluteRankStrength(d.finalScore)
        : Math.max(0, Math.min(1, d.finalScore / maxScore)),
      confFraction: Math.max(0, Math.min(1, relativeScore)),
      bm25Best: d.bm25Best,
      denseBest: d.denseBest,
      chunkHits: d.chunkHits,
    };
  });
}

/**
 * Compare ranking pool vs packed LLM context (why some titles drop from answer).
 */
export function buildCandidateCompare(
  rankedChunks: RankedChunk[],
  packed: RankedChunk[],
  limit = 20,
): CandidateCompareRow[] {
  const packedIds = new Set(packed.map((c) => c.chunkId));
  return rankedChunks.slice(0, limit).map((c) => ({
    chunkId: c.chunkId,
    documentId: c.documentId,
    title: c.title,
    snippet: (c.text || "").replace(/\s+/g, " ").trim().slice(0, 160),
    finalRank: c.finalRank,
    inPacked: packedIds.has(c.chunkId),
    bm25Rank: c.bm25Rank,
    denseRank: c.denseRank ?? null,
    finalScore: Number.isFinite(c.finalScore)
      ? (c.finalScore as number)
      : c.bm25Score,
  }));
}

/** Aggregate payload for demos / JSON export */
export function buildPipelineVizModel(input: {
  timing: Timing | null;
  metrics: Metrics | null;
  documents: RankedDocument[];
  rankedChunks: RankedChunk[];
  packedChunks: RankedChunk[];
}) {
  return {
    stages: buildStageTimeline(input.timing, input.metrics),
    waterfall: buildTimingWaterfall(input.timing, input.metrics),
    rankTransitions: buildRankTransitions(input.rankedChunks),
    documentScores: buildDocumentScoreSeries(input.documents),
    candidates: buildCandidateCompare(
      input.rankedChunks,
      input.packedChunks,
    ),
  };
}
