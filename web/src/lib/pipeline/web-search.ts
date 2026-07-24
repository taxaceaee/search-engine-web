import { getConfig, IR_DEFAULTS, resolveLlmModel } from "@/lib/config";
import { chunkDocuments } from "@/lib/ir/chunker";
import { retrieveEvidence } from "@/lib/ir/adaptive-rrf";
import { packContext } from "@/lib/ir/packer";
import {
  parseRetrievalMode,
  type RetrievalModeId,
} from "@/lib/ir/retrieval-modes";
import type { Metrics, RankedChunk, StreamEvent, Timing } from "@/lib/ir/types";
import { streamAnswer } from "@/lib/llm/client";
import { expandQueryForRetrieval } from "@/lib/ir/query-expansion";
import { fetchViaJina, searchWeb } from "@/lib/search/tavily";
import { elapsed, nowMs } from "@/lib/utils";
import { randomUUID } from "crypto";

export type WebSearchInput = {
  query: string;
  searchLimit?: number;
  retrieveTopK?: number;
  contextTopK?: number;
  generateAnswer?: boolean;
  enrichThinPages?: boolean;
  /** Per-request override; falls back to RETRIEVAL_MODE env. */
  retrievalMode?: RetrievalModeId;
  llmModel?: string;
  signal?: AbortSignal;
};

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    const err = new Error("Aborted");
    err.name = "AbortError";
    throw err;
  }
}

export async function runWebSearchPipeline(
  input: WebSearchInput,
  emit: (event: StreamEvent) => void,
): Promise<{
  answer: string;
  results: RankedChunk[];
  timing: Timing;
  metrics: Metrics;
}> {
  const cfg = getConfig();
  const query = input.query.trim();
  if (!query) throw new Error("Query is required");
  const signal = input.signal;

  const searchLimit = input.searchLimit ?? IR_DEFAULTS.searchLimit;
  const retrieveTopK = input.retrieveTopK ?? IR_DEFAULTS.retrieveTopK;
  const contextTopK = Math.min(
    input.contextTopK ?? IR_DEFAULTS.contextTopK,
    5,
  );
  const generateAnswer = input.generateAnswer ?? true;
  // Default off: Tavily already returns content; Jina multi-fetch blows Groq TPM
  const enrichThinPages = input.enrichThinPages ?? false;

  const totalStart = nowMs();
  const timing: Timing = {};
  const metrics: Metrics = { llmModel: resolveLlmModel(input.llmModel, cfg) };

  emit({ type: "search_started", query });
  assertNotAborted(signal);

  // 1) Search
  const searchStart = nowMs();
  const hits = await searchWeb(query, {
    tavilyKey: cfg.TAVILY_API_KEY,
    braveKey: cfg.BRAVE_API_KEY,
    limit: searchLimit,
  });
  assertNotAborted(signal);
  timing.searchMs = elapsed(searchStart);
  metrics.resultCount = hits.length;
  metrics.sourcePolicy = "public_scholarly_only";
  emit({ type: "search_completed", count: hits.length, ms: timing.searchMs });

  // 2) Optional enrich thin content via Jina (capped concurrency)
  const fetchStart = nowMs();
  const docs = await Promise.all(
    hits.map(async (hit, i) => {
      let text = (hit.content || hit.snippet || "").trim();
      // Cap raw page text early so BM25 corpus stays lean
      if (text.length > 12_000) text = text.slice(0, 12_000);
      if (enrichThinPages && text.split(/\s+/).length < 60 && hit.url) {
        const extra = await fetchViaJina(hit.url);
        if (extra.length > text.length) text = extra.slice(0, 12_000);
      }
      return {
        documentId: `web-${i}-${randomUUID().slice(0, 8)}`,
        title:
          hit.scholarlyKind === "preprint"
            ? `${hit.title} [Preprint]`
            : hit.title,
        url: hit.url,
        text,
      };
    }),
  );
  assertNotAborted(signal);
  const usable = docs.filter((d) => d.text.trim().length > 0);
  timing.fetchMs = elapsed(fetchStart);
  metrics.pageCount = usable.length;
  emit({ type: "fetch_completed", pages: usable.length, ms: timing.fetchMs });

  // 3) Chunk
  const chunkStart = nowMs();
  const chunks = chunkDocuments(usable);
  timing.chunkMs = elapsed(chunkStart);
  metrics.chunkCount = chunks.length;
  emit({ type: "chunk_completed", chunks: chunks.length, ms: timing.chunkMs });

  // 4) Retrieval + pack
  const retrieveStart = nowMs();
  const retrievalMode = parseRetrievalMode(
    input.retrievalMode,
    parseRetrievalMode(cfg.RETRIEVAL_MODE),
  );
  const retrieval = await retrieveEvidence(
    expandQueryForRetrieval(query),
    chunks,
    retrieveTopK,
    retrievalMode,
    { signal },
  );
  assertNotAborted(signal);
  const candidates = retrieval.results;
  const packStart = nowMs();
  const results = packContext(candidates, contextTopK, 2);
  timing.packMs = elapsed(packStart);
  timing.retrieveMs = elapsed(retrieveStart);
  timing.embeddingMs = retrieval.diagnostics.embeddingMs;
  timing.bm25Ms = retrieval.diagnostics.bm25Ms;
  timing.denseMs = retrieval.diagnostics.denseMs;
  timing.fusionMs = retrieval.diagnostics.fusionMs;
  timing.rankMs = Math.max(0, timing.retrieveMs - timing.packMs);
  metrics.contextCount = results.length;
  metrics.sourcesUsed = new Set(results.map((r) => r.documentId)).size;
  metrics.retrievalMode = retrieval.diagnostics.mode;
  metrics.denseUsed = retrieval.diagnostics.denseUsed;
  metrics.denseSkippedReason = retrieval.diagnostics.denseSkippedReason;
  metrics.embeddingProvider = retrieval.diagnostics.embeddingProvider;
  metrics.embeddingModel = retrieval.diagnostics.embeddingModel;
  metrics.embeddingInputCount = retrieval.diagnostics.embeddingInputCount;
  metrics.bm25Weight = retrieval.diagnostics.bm25Weight;
  emit({
    type: "retrieve_completed",
    results,
    ms: timing.retrieveMs,
  });

  // 5) Generate
  let answer = "";
  if (!generateAnswer) {
    metrics.llmUsed = false;
    metrics.llmSkippedReason = "generateAnswer=false";
    answer = "Answer generation was disabled for this request.";
  } else if (!cfg.hasLlm) {
    metrics.llmUsed = false;
    metrics.llmSkippedReason = "LLM_API_KEY not configured";
    answer =
      "Search completed, but LLM_API_KEY is not configured so no answer could be generated.";
  } else if (results.length === 0) {
    metrics.llmUsed = false;
    metrics.llmSkippedReason = "No evidence chunks";
    answer = "No relevant web content found to answer this question.";
  } else {
    emit({ type: "generation_started" });
    const genStart = nowMs();
    try {
      answer = await streamAnswer({
        query,
        chunks: results,
        model: input.llmModel,
        sourceScope: "web-scholarly",
        signal,
        onToken: async (token) => emit({ type: "generation_token", token }),
      });
      metrics.llmUsed = true;
    } catch (err) {
      if ((err as Error)?.name === "AbortError") throw err;
      metrics.llmUsed = false;
      metrics.llmSkippedReason =
        err instanceof Error ? err.message : "LLM generation failed";
      const partial = (err as Error & { partial?: string })?.partial?.trim();
      answer =
        partial ||
        `Generation failed: ${metrics.llmSkippedReason}. Retrieval results are still available as citations.`;
      emit({
        type: "error",
        message: `Generation failed: ${metrics.llmSkippedReason}`,
      });
    }
    timing.generateMs = elapsed(genStart);
  }

  timing.totalMs = elapsed(totalStart);
  emit({
    type: "run_completed",
    answer,
    timing,
    metrics,
    results,
  });

  return { answer, results, timing, metrics };
}
