import { describe, expect, it } from "vitest";
import {
  buildCandidateCompare,
  buildDocumentScoreSeries,
  buildPipelineVizModel,
  buildRankTransitions,
  buildStageTimeline,
  buildTimingWaterfall,
} from "./pipeline-viz";
import type { Metrics, RankedChunk, RankedDocument, Timing } from "./types";

function chunk(
  partial: Partial<RankedChunk> &
    Pick<RankedChunk, "chunkId" | "documentId" | "bm25Rank" | "finalRank">,
): RankedChunk {
  return {
    title: partial.title || `T-${partial.documentId}`,
    text: partial.text || "evidence text about retrieval ranking",
    chunkIndex: 0,
    bm25Score: partial.bm25Score ?? 1,
    finalScore: partial.finalScore ?? partial.bm25Score ?? 1,
    citationId: partial.finalRank,
    denseRank: partial.denseRank,
    denseScore: partial.denseScore,
    ...partial,
  };
}

const timing: Timing = {
  queryProcessMs: 1,
  bm25Ms: 10,
  embeddingMs: 40,
  denseMs: 2,
  fusionMs: 3,
  packMs: 1,
  generateMs: 50,
  rankMs: 55,
  totalMs: 110,
  ttftMs: 12,
};

const metricsHybrid: Metrics = {
  retrievalMode: "adaptive_rrf",
  denseUsed: true,
  embeddingProvider: "tei",
  embeddingModel: "bge",
  bm25Weight: 0.42,
  contextCount: 2,
  sourcesUsed: 2,
  llmUsed: true,
  documentsRanked: 2,
  relativeScoreMax: 0.9,
  confidenceMax: 0.9,
};

describe("buildStageTimeline", () => {
  it("covers major IR stages with explanations and ms from shipped Timing", () => {
    const stages = buildStageTimeline(timing, metricsHybrid);
    const ids = stages.map((s) => s.id);
    expect(ids).toEqual([
      "query",
      "bm25",
      "embedding",
      "fusion",
      "pack",
      "generate",
    ]);
    for (const s of stages) {
      expect(s.explanation.length).toBeGreaterThan(20);
      expect(s.outcome).toBe("ran");
    }
    expect(stages.find((s) => s.id === "bm25")?.ms).toBe(10);
    expect(stages.find((s) => s.id === "fusion")?.detail).toMatch(/Classic RRF|RRF/);
  });

  it("shows route-level corpus load cost when it is measured", () => {
    const measured = buildStageTimeline(
      { notebookLookupMs: 20, corpusLoadMs: 80, corpusMergeMs: 3, totalMs: 110 },
      { retrievalMode: "bm25", denseUsed: false },
    );
    expect(measured[0]).toMatchObject({ id: "corpus", ms: 103, outcome: "ran" });
  });

  it("marks dense/fusion skipped honestly on BM25-only runs", () => {
    const stages = buildStageTimeline(
      { queryProcessMs: 0, bm25Ms: 5, packMs: 1, totalMs: 8 },
      {
        retrievalMode: "bm25",
        denseUsed: false,
        llmUsed: false,
        llmSkippedReason: "generateAnswer=false",
        contextCount: 1,
      },
    );
    expect(stages.find((s) => s.id === "embedding")?.outcome).toBe("skipped");
    expect(stages.find((s) => s.id === "fusion")?.outcome).toBe("skipped");
    expect(stages.find((s) => s.id === "generate")?.outcome).toBe("skipped");
  });
});

describe("buildTimingWaterfall", () => {
  it("produces sequential bars with fractions summing near wall total", () => {
    const bars = buildTimingWaterfall(timing, metricsHybrid);
    expect(bars.length).toBeGreaterThanOrEqual(4);
    expect(bars.every((b) => b.fraction >= 0 && b.offsetFraction >= 0)).toBe(
      true,
    );
    const last = bars[bars.length - 1];
    expect(last.offsetFraction + last.fraction).toBeLessThanOrEqual(1.0001);
    expect(bars.find((b) => b.id === "rank")?.ms).toBe(55);
    expect(bars.find((b) => b.id === "generate")?.ms).toBe(50);
  });

  it("does not add overlapping BM25 and embedding timings", () => {
    const bars = buildTimingWaterfall(
      {
        bm25Ms: 100,
        embeddingMs: 120,
        fusionMs: 5,
        rankMs: 125,
        packMs: 2,
        generateMs: 50,
        totalMs: 180,
      },
      metricsHybrid,
    );
    expect(bars.find((b) => b.id === "rank")?.ms).toBe(125);
    expect(bars.some((b) => b.id === "bm25" || b.id === "embedding")).toBe(false);
    expect(bars.reduce((sum, bar) => sum + bar.ms, 0)).toBe(180);
  });
});

describe("buildRankTransitions", () => {
  it("maps BM25 → dense → final ranks from RankedChunk fields", () => {
    const rows = buildRankTransitions([
      chunk({
        chunkId: "a",
        documentId: "d1",
        title: "Alpha",
        bm25Rank: 5,
        denseRank: 1,
        finalRank: 1,
        bm25Score: 1.2,
        denseScore: 0.9,
        finalScore: 0.05,
      }),
      chunk({
        chunkId: "b",
        documentId: "d2",
        title: "Beta",
        bm25Rank: 1,
        denseRank: 8,
        finalRank: 3,
        bm25Score: 3,
        denseScore: 0.1,
        finalScore: 0.02,
      }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].rankDeltaFromBm25).toBe(4); // improved from 5 to 1
    expect(rows[1].rankDeltaFromBm25).toBe(-2); // fell from 1 to 3
    expect(rows[0].denseRank).toBe(1);
    expect(rows[0].snippet.length).toBeGreaterThan(0);
  });
});

describe("buildDocumentScoreSeries", () => {
  it("normalizes score bars relative to max finalScore", () => {
    const docs: RankedDocument[] = [
      {
        documentId: "d1",
        title: "A",
        finalScore: 4,
        finalRank: 1,
        relativeScore: 1,
        confidence: 1,
        chunkHits: 2,
        topChunkIds: ["c1"],
      },
      {
        documentId: "d2",
        title: "B",
        finalScore: 2,
        finalRank: 2,
        relativeScore: 0.4,
        confidence: 0.4,
        chunkHits: 1,
        topChunkIds: ["c2"],
      },
    ];
    const series = buildDocumentScoreSeries(docs);
    expect(series[0].scoreFraction).toBeCloseTo(1);
    expect(series[1].scoreFraction).toBeCloseTo(0.5);
    expect(series[1].confFraction).toBeCloseTo(0.4);
  });

  it("keeps absolute RRF strength distinct from relative score", () => {
    const docs: RankedDocument[] = [
      {
        documentId: "d1",
        title: "A",
        finalScore: 0.022,
        finalRank: 1,
        relativeScore: 1,
        confidence: 1,
        chunkHits: 1,
        topChunkIds: ["c1"],
      },
      {
        documentId: "d2",
        title: "B",
        finalScore: 0.018,
        finalRank: 2,
        relativeScore: 0.818,
        confidence: 0.818,
        chunkHits: 1,
        topChunkIds: ["c2"],
      },
    ];
    const series = buildDocumentScoreSeries(docs, "adaptive_rrf");
    expect(series[0].scoreFraction).toBeLessThan(1);
    expect(series[0].scoreFraction).not.toBeCloseTo(series[0].confFraction);
    expect(series[1].scoreFraction).not.toBeCloseTo(series[1].confFraction);
  });

  it("does not render duplicate document ids", () => {
    const document = {
      documentId: "same-source",
      title: "Same source",
      finalScore: 0.02,
      finalRank: 1,
      relativeScore: 1,
      confidence: 1,
      chunkHits: 1,
      topChunkIds: ["c1"],
    } satisfies RankedDocument;
    const series = buildDocumentScoreSeries([
      document,
      { ...document, finalScore: 0.01, finalRank: 2, topChunkIds: ["c2"] },
    ]);
    expect(series).toHaveLength(1);
    expect(series[0].finalScore).toBe(0.02);
  });
});

describe("buildCandidateCompare + buildPipelineVizModel", () => {
  it("flags packed vs ranking pool and assembles full viz model", () => {
    const ranked = [
      chunk({
        chunkId: "c1",
        documentId: "d1",
        bm25Rank: 1,
        finalRank: 1,
        finalScore: 2,
      }),
      chunk({
        chunkId: "c2",
        documentId: "d2",
        bm25Rank: 2,
        finalRank: 2,
        finalScore: 1,
      }),
    ];
    const packed = [ranked[0]];
    const cmp = buildCandidateCompare(ranked, packed);
    expect(cmp[0].inPacked).toBe(true);
    expect(cmp[1].inPacked).toBe(false);

    const model = buildPipelineVizModel({
      timing,
      metrics: metricsHybrid,
      documents: [
        {
          documentId: "d1",
          title: "A",
          finalScore: 2,
          finalRank: 1,
          relativeScore: 0.9,
          confidence: 0.9,
          chunkHits: 1,
          topChunkIds: ["c1"],
        },
      ],
      rankedChunks: ranked,
      packedChunks: packed,
    });
    expect(model.stages.length).toBe(6);
    expect(model.waterfall.length).toBeGreaterThan(0);
    expect(model.rankTransitions.length).toBe(2);
    expect(model.documentScores.length).toBe(1);
    expect(model.candidates.filter((c) => c.inPacked)).toHaveLength(1);
  });
});
