/**
 * Pre-compute and persist embeddings for a notebook's raw sources.
 * Query path then only embeds the user query (dense retrieval hot path).
 *
 * Vectors are stored in Supabase/Postgres `chunks.embedding_json`
 * (not MongoDB — durable app DB is Postgres via Supabase).
 */
import { randomUUID } from "crypto";
import { getConfig, IR_DEFAULTS } from "@/lib/config";
import {
  listSourcesForIndex,
  getChunkStats,
  replaceNotebookChunks,
  replaceNotebookChunksForSources,
  updateNotebookIndexMeta,
  type ChunkWriteRow,
} from "@/lib/db/notebooks-repo";
import { expandRawSourcesToUnits } from "@/lib/ir/raw-units";
import { embedTexts } from "@/lib/ir/embedding";

const EMBED_BATCH = 16;
/** Cap stored units per notebook (dense index size). */
const MAX_INDEX_UNITS = Math.max(IR_DEFAULTS.maxChunksPerNotebook, 800);

export type IndexProgressEvent =
  | {
      type: "index_started";
      unitCount: number;
      message: string;
    }
  | {
      type: "chunk_started";
      message: string;
    }
  | {
      type: "chunk_completed";
      chunkCount: number;
      chunkMs: number;
      message: string;
    }
  | {
      type: "embed_started";
      total: number;
      message: string;
    }
  | {
      type: "index_progress";
      done: number;
      total: number;
      message: string;
    }
  | {
      type: "persist_started";
      total: number;
      message: string;
    }
  | {
      type: "persist_completed";
      persistMs: number;
      message: string;
    }
  | {
      type: "index_completed";
      unitCount: number;
      embeddedCount: number;
      model: string;
      provider: string;
      embedMs: number;
      chunkMs: number;
      persistMs: number;
      totalMs: number;
      storage: "supabase-postgres";
      message: string;
    }
  | {
      type: "index_failed";
      message: string;
    }
  | {
      type: "index_skipped";
      message: string;
      reason: string;
    };

export type IndexNotebookResult = {
  notebookId: string;
  unitCount: number;
  embeddedCount: number;
  model: string;
  provider: string;
  embedMs: number;
  chunkMs: number;
  persistMs: number;
  totalMs: number;
  status: "ready" | "skipped" | "failed";
  message: string;
};

export type IndexNotebookOptions = {
  maxUnits?: number;
  batchSize?: number;
  /** Incremental upload path; omit to rebuild the complete notebook index. */
  sourceIds?: string[];
  onProgress?: (event: IndexProgressEvent) => void;
};

const globalForIndexQueue = globalThis as unknown as {
  __notebookIndexQueues?: Map<string, Promise<unknown>>;
};
const notebookIndexQueues =
  globalForIndexQueue.__notebookIndexQueues ?? new Map<string, Promise<unknown>>();
globalForIndexQueue.__notebookIndexQueues = notebookIndexQueues;

/**
 * Expand raw sources → embed units → write `chunks` with embedding_json.
 * Full rebuilds replace the notebook index; upload paths replace only the
 * requested source rows.
 */
/** Serialize index mutations per notebook to avoid concurrent delete/insert races. */
export function indexNotebookEmbeddings(
  notebookId: string,
  opts?: IndexNotebookOptions,
): Promise<IndexNotebookResult> {
  const previous = notebookIndexQueues.get(notebookId) || Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => indexNotebookEmbeddingsUnqueued(notebookId, opts));
  const tracked = current.finally(() => {
    if (notebookIndexQueues.get(notebookId) === tracked) {
      notebookIndexQueues.delete(notebookId);
    }
  });
  notebookIndexQueues.set(notebookId, tracked);
  return tracked;
}

async function indexNotebookEmbeddingsUnqueued(
  notebookId: string,
  opts?: IndexNotebookOptions,
): Promise<IndexNotebookResult> {
  const cfg = getConfig();
  const emit = opts?.onProgress;
  const totalStart = performance.now();

  try {
    await updateNotebookIndexMeta(notebookId, {
      indexStatus: "indexing",
      indexMessage: "Building dense index…",
    });

    const requestedSourceIds = [...new Set(opts?.sourceIds?.filter(Boolean) || [])];
    const allSources = await listSourcesForIndex(
      notebookId,
      requestedSourceIds.length ? requestedSourceIds : undefined,
    );
    const sources = requestedSourceIds.length
      ? allSources.filter((source) => requestedSourceIds.includes(source.id))
      : allSources;
    const indexedSourceIds = requestedSourceIds.length
      ? requestedSourceIds
      : undefined;
    emit?.({
      type: "chunk_started",
      message: `Preparing retrieval chunks from ${sources.length} source${sources.length === 1 ? "" : "s"}…`,
    });
    const chunkStart = performance.now();
    const units = expandRawSourcesToUnits(
      sources.map((s) => ({
        id: s.id,
        title: s.title,
        text: s.text,
        mime: s.mime,
      })),
    ).slice(0, opts?.maxUnits ?? MAX_INDEX_UNITS);
    const metadataStats = async (fallbackEmbeddedCount: number) =>
      indexedSourceIds
        ? await getChunkStats(notebookId)
        : { unitCount: units.length, embeddedCount: fallbackEmbeddedCount };
    const chunkMs = Math.round(performance.now() - chunkStart);
    emit?.({
      type: "chunk_completed",
      chunkCount: units.length,
      chunkMs,
      message: `Prepared ${units.length} retrieval chunks`,
    });

    emit?.({
      type: "index_started",
      unitCount: units.length,
      message: `Indexing ${units.length} units → Supabase Postgres`,
    });

    if (units.length === 0) {
      if (indexedSourceIds) {
        await replaceNotebookChunksForSources(notebookId, indexedSourceIds, []);
      } else {
        await replaceNotebookChunks(notebookId, []);
      }
      const stored = await metadataStats(0);
      const message = "No text units to embed.";
      await updateNotebookIndexMeta(notebookId, {
        indexStatus: "ready",
        indexMessage: message,
        unitCount: stored.unitCount,
        embeddedCount: stored.embeddedCount,
        indexedAt: new Date().toISOString(),
      });
      emit?.({
        type: "index_completed",
        unitCount: stored.unitCount,
        embeddedCount: stored.embeddedCount,
        model: cfg.EMBEDDING_MODEL,
        provider: cfg.EMBEDDING_PROVIDER,
        embedMs: 0,
        chunkMs,
        persistMs: 0,
        totalMs: Math.round(performance.now() - totalStart),
        storage: "supabase-postgres",
        message,
      });
      return {
        notebookId,
        unitCount: stored.unitCount,
        embeddedCount: stored.embeddedCount,
        model: cfg.EMBEDDING_MODEL,
        provider: cfg.EMBEDDING_PROVIDER,
        embedMs: 0,
        chunkMs,
        persistMs: 0,
        totalMs: Math.round(performance.now() - totalStart),
        status: "ready",
        message,
      };
    }

    // Lexical indexing is useful even when dense embeddings are unavailable.
    // Persisting the chunks here prevents every later query from downloading
    // and re-parsing the full raw source document.
    if (!cfg.hasEmbedding) {
      const rows: ChunkWriteRow[] = units.map((u) => ({
        id: randomUUID(),
        sourceId: u.documentId.split("#")[0],
        notebookId,
        chunkIndex: u.chunkIndex,
        text: u.text,
        embedding: null,
        embeddingModel: null,
      }));
      const persistStart = performance.now();
      emit?.({
        type: "persist_started",
        total: rows.length,
        message: `Persisting ${rows.length} lexical chunks to database…`,
      });
      if (indexedSourceIds) {
        await replaceNotebookChunksForSources(notebookId, indexedSourceIds, rows);
      } else {
        await replaceNotebookChunks(notebookId, rows);
      }
      const persistMs = Math.round(performance.now() - persistStart);
      const totalMs = Math.round(performance.now() - totalStart);
      const stored = await metadataStats(0);
      const message =
        `Stored ${rows.length} lexical chunks; dense index skipped because embedding is not configured.`;
      await updateNotebookIndexMeta(notebookId, {
        indexStatus: "skipped",
        indexMessage: message,
        unitCount: stored.unitCount,
        embeddedCount: stored.embeddedCount,
        indexedAt: new Date().toISOString(),
      });
      emit?.({
        type: "persist_completed",
        persistMs,
        message: `Persisted ${rows.length} lexical chunks`,
      });
      emit?.({ type: "index_skipped", message, reason: "no_embedding_config" });
      return {
        notebookId,
        unitCount: stored.unitCount,
        embeddedCount: stored.embeddedCount,
        model: cfg.EMBEDDING_MODEL,
        provider: cfg.EMBEDDING_PROVIDER,
        embedMs: 0,
        chunkMs,
        persistMs,
        totalMs,
        status: "skipped",
        message,
      };
    }

    const batchSize = opts?.batchSize ?? EMBED_BATCH;
    const embeddings: number[][] = Array.from({ length: units.length });
    let model = cfg.EMBEDDING_MODEL;
    let provider: string = cfg.EMBEDDING_PROVIDER;
    const embedStart = performance.now();
    emit?.({
      type: "embed_started",
      total: units.length,
      message: `Embedding ${units.length} chunks…`,
    });

    const batchStarts = Array.from(
      { length: Math.ceil(units.length / batchSize) },
      (_, batch) => batch * batchSize,
    );
    const concurrency = Math.min(
      Math.max(1, IR_DEFAULTS.indexEmbeddingConcurrency),
      batchStarts.length,
    );
    let nextBatch = 0;
    let completedUnits = 0;
    const embedBatch = async () => {
      while (nextBatch < batchStarts.length) {
        const batchIndex = nextBatch++;
        const start = batchStarts[batchIndex];
        const slice = units.slice(start, start + batchSize);
        let lastErr: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            // Indexing can process larger batches than query-time retrieval.
            // Keep a generous timeout here; query-time calls use a shorter budget
            // and fall back to BM25 when the provider is slow.
            const res = await embedTexts(slice.map((u) => u.text), {
              timeoutMs: 30_000,
            });
            for (let offset = 0; offset < res.embeddings.length; offset++) {
              embeddings[start + offset] = res.embeddings[offset];
            }
            model = res.model;
            provider = res.provider;
            completedUnits += slice.length;
            emit?.({
              type: "index_progress",
              done: completedUnits,
              total: units.length,
              message: `Embedded ${completedUnits}/${units.length} units`,
            });
            process.stdout?.write?.(
              `[index] ${completedUnits}/${units.length} embedded\r`,
            );
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          }
        }
        if (lastErr) throw lastErr;
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => embedBatch()));

    const embedMs = Math.round(performance.now() - embedStart);
    const rows: ChunkWriteRow[] = units.map((u, i) => {
      const baseSourceId = u.documentId.split("#")[0];
      return {
        id: randomUUID(),
        sourceId: baseSourceId,
        notebookId,
        chunkIndex: i,
        text: u.text,
        embedding: embeddings[i] ?? null,
        embeddingModel: model,
      };
    });

    emit?.({
      type: "persist_started",
      total: rows.length,
      message: `Persisting ${rows.length} vectors to database…`,
    });
    const persistStart = performance.now();

    emit?.({
      type: "index_progress",
      done: units.length,
      total: units.length,
      message: `Writing ${rows.length} vectors to database…`,
    });

    if (indexedSourceIds) {
      await replaceNotebookChunksForSources(notebookId, indexedSourceIds, rows);
    } else {
      await replaceNotebookChunks(notebookId, rows);
    }
    const persistMs = Math.round(performance.now() - persistStart);
    emit?.({
      type: "persist_completed",
      persistMs,
      message: `Persisted ${rows.length} vectors`,
    });

    const embeddedCount = rows.filter(
      (r) => r.embedding && r.embedding.length > 0,
    ).length;
    const stored = await metadataStats(embeddedCount);
    const totalMs = Math.round(performance.now() - totalStart);
    const message = `Indexed ${stored.embeddedCount}/${stored.unitCount} vectors in Postgres (${embedMs}ms embed)`;

    await updateNotebookIndexMeta(notebookId, {
      indexStatus: "ready",
      indexMessage: message,
      unitCount: stored.unitCount,
      embeddedCount: stored.embeddedCount,
      indexedAt: new Date().toISOString(),
    });

    emit?.({
      type: "index_completed",
      unitCount: stored.unitCount,
      embeddedCount: stored.embeddedCount,
      model,
      provider,
      embedMs,
      chunkMs,
      persistMs,
      totalMs,
      storage: "supabase-postgres",
      message,
    });

    return {
      notebookId,
      unitCount: stored.unitCount,
      embeddedCount: stored.embeddedCount,
      model,
      provider,
      embedMs,
      chunkMs,
      persistMs,
      totalMs,
      status: "ready",
      message,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Indexing failed";
    await updateNotebookIndexMeta(notebookId, {
      indexStatus: "failed",
      indexMessage: message,
    });
    emit?.({ type: "index_failed", message });
    return {
      notebookId,
      unitCount: 0,
      embeddedCount: 0,
      model: cfg.EMBEDDING_MODEL,
      provider: cfg.EMBEDDING_PROVIDER,
      embedMs: 0,
      chunkMs: 0,
      persistMs: 0,
      totalMs: Math.round(performance.now() - totalStart),
      status: "failed",
      message,
    };
  }
}

/** Fire-and-forget wrapper for non-SSE paths (never throws to caller). */
export function scheduleNotebookIndex(notebookId: string, sourceIds?: string[]): void {
  void indexNotebookEmbeddings(notebookId, { sourceIds }).then(
    (r) => {
      console.info(
        `[index] notebook ${notebookId}: ${r.status} ${r.embeddedCount}/${r.unitCount} — ${r.message}`,
      );
    },
    (err) => {
      console.warn(
        `[index] notebook ${notebookId} failed:`,
        err instanceof Error ? err.message : err,
      );
    },
  );
}
