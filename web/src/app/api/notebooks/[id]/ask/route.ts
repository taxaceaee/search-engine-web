import { z } from "zod";
import { after } from "next/server";
import { requireUserId } from "@/lib/auth";
import { getConfig, IR_DEFAULTS } from "@/lib/config";
import { getChunkStats, getNotebook, loadChunks } from "@/lib/db/notebooks-repo";
import { addNotebookMessage } from "@/lib/db/notebook-messages-repo";
import { runNotebookAskPipeline } from "@/lib/pipeline/notebook-ask";
import { createSseResponse } from "@/lib/sse";
import {
  parseRetrievalMode,
  RETRIEVAL_MODE_IDS,
} from "@/lib/ir/retrieval-modes";
import { elapsed, nowMs } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z.object({
  query: z.string().min(1).max(2000),
  sourceIds: z.array(z.string()).optional(),
  /** Extra notebook IDs (checked datasets) merged into this ask corpus */
  notebookIds: z.array(z.string().min(1)).max(20).optional(),
  contextTopK: z.number().int().min(1).max(12).optional(),
  retrieveTopK: z.number().int().min(1).max(80).optional(),
  documentTopK: z.number().int().min(1).max(20).optional(),
  generateAnswer: z.boolean().optional(),
  /** Per-request retrieval method; defaults to RETRIEVAL_MODE env. */
  retrievalMode: z.enum(RETRIEVAL_MODE_IDS).optional(),
  llmModel: z.string().trim().min(1).max(160).optional(),
});

/** Persist history without blocking the answer stream (log failures). */
function persistHistory(
  label: string,
  work: () => Promise<unknown>,
): Promise<void> {
  return work().then(
    () => undefined,
    (err) => {
      console.error(
        `[notebook ask] ${label}`,
        err instanceof Error ? err.message : err,
      );
    },
  );
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = requireUserId(req);
  if ("error" in auth) return auth.error;

  const { id } = await ctx.params;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }

  const notebookLookupStart = nowMs();
  // Metadata columns are absent/stale on older notebooks. Count chunks in
  // parallel with the notebook lookup so dense completeness is decided from
  // the actual corpus without adding a serial round trip.
  const [notebook, chunkStats] = await Promise.all([
    getNotebook(id),
    getChunkStats(id, { includeSourceCoverage: true }).catch(() => null),
  ]);
  const notebookLookupMs = elapsed(notebookLookupStart);
  if (!notebook) {
    return Response.json({ error: "Notebook not found" }, { status: 404 });
  }

  // Primary notebook + optional checked corpora for multi-dataset ask
  const extraIds = [
    ...new Set(
      (parsed.data.notebookIds || []).filter((nid) => nid && nid !== id),
    ),
  ].slice(0, 19);
  const corpusIds = [id, ...extraIds];
  const query = parsed.data.query.trim();
  const cfg = getConfig();
  const retrievalMode = parseRetrievalMode(
    parsed.data.retrievalMode,
    parseRetrievalMode(cfg.RETRIEVAL_MODE),
  );
  // BM25 and the legacy branch intentionally do not consume stored vectors.
  // If metadata proves the dense index is incomplete, use the same BM25
  // fallback that retrieval would eventually choose without downloading a
  // large JSON vector payload or making a live embedding call first.
  const corpusUnitCount = chunkStats?.unitCount || notebook.unitCount;
  const corpusEmbeddedCount = chunkStats
    ? chunkStats.embeddedCount
    : notebook.embeddedCount;
  const knownIncompleteDenseIndex =
    (corpusUnitCount > 0 && corpusEmbeddedCount < corpusUnitCount) ||
    Boolean(
      chunkStats &&
        chunkStats.sourceCount != null &&
        chunkStats.indexedSourceCount != null &&
        chunkStats.indexedSourceCount < chunkStats.sourceCount,
    );
  const includeEmbeddings =
    retrievalMode !== "bm25" &&
    retrievalMode !== "legacy_rrf_ce" &&
    !knownIncompleteDenseIndex;
  const bm25CandidateLimit = Math.min(
    1000,
    Math.max(240, (parsed.data.retrieveTopK ?? 20) * 8),
  );
  const bm25MinCandidates = parsed.data.retrieveTopK ?? 20;
  // For a large complete index, FTS can safely narrow the dense payload to
  // the same 512-unit ceiling already used before dense ranking. If FTS is
  // unavailable or returns fewer candidates, loadChunks keeps full fallback.
  const densePrefilter =
    retrievalMode === "adaptive_rrf" &&
    includeEmbeddings &&
    corpusUnitCount > IR_DEFAULTS.maxDenseChunks;

  return createSseResponse(async (emit, { signal }) => {
    emit({ type: "corpus_loading" });
    const loadStart = nowMs();
    const chunkLists = await Promise.all(
      corpusIds.map((nid) =>
        loadChunks(
          nid,
          // source filter only applies to the primary notebook workspace
          nid === id ? parsed.data.sourceIds : undefined,
          {
            includeEmbeddings,
            searchQuery:
              retrievalMode === "bm25" || densePrefilter ? query : undefined,
            searchCandidateLimit:
              retrievalMode === "bm25"
                ? bm25CandidateLimit
                : densePrefilter
                  ? IR_DEFAULTS.maxDenseChunks
                  : undefined,
            searchMinCandidates:
              retrievalMode === "bm25"
                ? bm25MinCandidates
                : densePrefilter
                  ? IR_DEFAULTS.maxDenseChunks
                  : undefined,
          },
        ),
      ),
    );
    const corpusLoadMs = elapsed(loadStart);

    // Merge retrieval units; prefix chunk ids when multi-corpus to avoid collisions
    const mergeStart = nowMs();
    const multi = corpusIds.length > 1;
    const chunks = multi
      ? chunkLists.flatMap((list, i) => {
          const nid = corpusIds[i];
          return list.map((c) => ({
            ...c,
            chunkId: `${nid}:${c.chunkId}`,
            // Keep documentId stable for source drawer within its notebook —
            // rank UI uses document title; multi-corpus titles already differ.
          }));
        })
      : (chunkLists[0] ?? []);
    const corpusMergeMs = elapsed(mergeStart);

    if (chunks.length === 0) {
      throw new Error(
        corpusIds.length > 1
          ? "Selected datasets have no sources. Upload documents or uncheck empty datasets."
          : "Notebook has no sources. Store a raw document first.",
      );
    }

    emit({
      type: "corpus_loaded",
      chunks: chunks.length,
      loadMs: corpusLoadMs,
      mergeMs: corpusMergeMs,
    });

    // Fire-and-forget user message so TTFT is not blocked on history I/O
    const userSave = persistHistory("save user message", () =>
      addNotebookMessage({
        notebookId: id,
        userId: auth.userId,
        role: "user",
        content: query,
        status: "completed",
      }),
    );

    try {
      const result = await runNotebookAskPipeline(
        {
          query,
          chunks,
          contextTopK: parsed.data.contextTopK,
          retrieveTopK: parsed.data.retrieveTopK,
          documentTopK: parsed.data.documentTopK ?? 10,
          generateAnswer: parsed.data.generateAnswer,
          retrievalMode,
          llmModel: parsed.data.llmModel,
          notebookLookupMs,
          corpusLoadMs,
          corpusMergeMs,
          signal,
        },
        emit,
      );

      // History is durable side effect, not part of answer latency. Do not
      // hold the SSE close while Supabase writes the assistant message.
      after(() => Promise.all([
        userSave,
        persistHistory("save assistant message", () =>
          addNotebookMessage({
            notebookId: id,
            userId: auth.userId,
            role: "assistant",
            content: result.answer || "",
            results: result.results,
            timing: result.timing,
            metrics: result.metrics,
            documents: result.documents,
            status: "completed",
          }),
        ),
      ]));
    } catch (err) {
      if ((err as Error)?.name === "AbortError") throw err;
      const message = err instanceof Error ? err.message : "Ask failed";
      await Promise.all([
        userSave,
        persistHistory("save failed assistant", () =>
          addNotebookMessage({
            notebookId: id,
            userId: auth.userId,
            role: "assistant",
            content: `Error: ${message}`,
            status: "failed",
          }),
        ),
      ]);
      emit({ type: "error", message });
    }
  }, req);
}
