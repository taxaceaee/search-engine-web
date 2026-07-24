import { and, desc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { ChunkWithEmbedding } from "@/lib/ir/types";
import { expandRawSourcesToUnits } from "@/lib/ir/raw-units";
import { IR_DEFAULTS } from "@/lib/config";
import { assertDurableDb, dbBackend, enrichDbError, getDb, hasDb } from "./client";
import { chunks, notebooks, sources } from "./schema";
import { getSupabaseAdmin, sbError, toIso } from "./supabase";
import { isProtectedDatasetTitle } from "../protected-datasets";
import {
  memChunks,
  memNotebooks,
  memSources,
  type MemNotebook,
  type MemSource,
} from "./memory";

function vectorOrNull(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  return value;
}

function isMissingEmbeddingColumn(error: unknown) {
  const text =
    typeof error === "string"
      ? error
      : error && typeof error === "object"
        ? JSON.stringify(error)
        : "";
  // Postgres undefined_column, or PostgREST schema-cache miss (PGRST204).
  return (
    text.includes("embedding_json") ||
    text.includes("embedding_model")
  ) && (
    text.includes("42703") ||
    text.includes("PGRST204") ||
    text.includes("schema cache") ||
    text.includes("does not exist") ||
    text.includes("Could not find")
  );
}

type ChunkRow = {
  id: string;
  source_id: string;
  chunk_index: number;
  text: string;
  embedding_json?: unknown;
  embedding_model?: string | null;
};

export type LoadChunksOptions = {
  /** BM25-only and legacy retrieval do not need stored vectors. */
  includeEmbeddings?: boolean;
  /** Optional PostgreSQL FTS prefilter for BM25 candidate loading. */
  searchQuery?: string;
  searchCandidateLimit?: number;
  searchMinCandidates?: number;
};

type RetrievalCacheEntry = {
  chunks: ChunkWithEmbedding[];
  expiresAt: number;
};

const RETRIEVAL_CACHE_TTL_MS = 5 * 60 * 1000;
const RETRIEVAL_CACHE_MAX_ENTRIES = 4;
const globalForRetrievalCache = globalThis as unknown as {
  __notebookRetrievalCache?: Map<string, RetrievalCacheEntry>;
};
const notebookRetrievalCache =
  globalForRetrievalCache.__notebookRetrievalCache ??
  new Map<string, RetrievalCacheEntry>();
globalForRetrievalCache.__notebookRetrievalCache = notebookRetrievalCache;
const globalForRetrievalInflight = globalThis as unknown as {
  __notebookRetrievalInflight?: Map<string, Promise<ChunkWithEmbedding[]>>;
};
const notebookRetrievalInflight =
  globalForRetrievalInflight.__notebookRetrievalInflight ??
  new Map<string, Promise<ChunkWithEmbedding[]>>();
globalForRetrievalInflight.__notebookRetrievalInflight = notebookRetrievalInflight;
const globalForRetrievalEpoch = globalThis as unknown as {
  __notebookRetrievalEpoch?: Map<string, number>;
};
const notebookRetrievalEpoch =
  globalForRetrievalEpoch.__notebookRetrievalEpoch ?? new Map<string, number>();
globalForRetrievalEpoch.__notebookRetrievalEpoch = notebookRetrievalEpoch;

function retrievalCacheKey(
  notebookId: string,
  sourceIds: string[] | undefined,
  includeEmbeddings: boolean,
  searchQuery?: string,
  searchCandidateLimit?: number,
  searchMinCandidates?: number,
) {
  const scope = sourceIds?.length ? [...new Set(sourceIds)].sort().join(",") : "*";
  const searchScope = searchQuery
    ? `:fts:${encodeURIComponent(searchQuery)}:${searchCandidateLimit || 0}:${searchMinCandidates || 0}`
    : "";
  return `${notebookId}:${includeEmbeddings ? "vectors" : "text"}:${scope}${searchScope}`;
}

function getCachedRetrievalUnits(key: string) {
  const entry = notebookRetrievalCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    notebookRetrievalCache.delete(key);
    return null;
  }
  // Refresh insertion order for a small LRU cache.
  notebookRetrievalCache.delete(key);
  notebookRetrievalCache.set(key, entry);
  return entry.chunks;
}

function setCachedRetrievalUnits(key: string, chunks: ChunkWithEmbedding[]) {
  notebookRetrievalCache.delete(key);
  notebookRetrievalCache.set(key, {
    chunks,
    expiresAt: Date.now() + RETRIEVAL_CACHE_TTL_MS,
  });
  while (notebookRetrievalCache.size > RETRIEVAL_CACHE_MAX_ENTRIES) {
    const oldest = notebookRetrievalCache.keys().next().value as string | undefined;
    if (!oldest) break;
    notebookRetrievalCache.delete(oldest);
  }
}

/** Invalidate all retrieval variants after source/index mutations. */
export function invalidateNotebookRetrievalCache(notebookId: string): void {
  notebookRetrievalEpoch.set(
    notebookId,
    (notebookRetrievalEpoch.get(notebookId) || 0) + 1,
  );
  for (const key of notebookRetrievalCache.keys()) {
    if (key.startsWith(`${notebookId}:`)) notebookRetrievalCache.delete(key);
  }
  for (const key of notebookRetrievalInflight.keys()) {
    if (key.startsWith(`${notebookId}:`)) notebookRetrievalInflight.delete(key);
  }
}

export type NotebookIndexStatus =
  | "none"
  | "indexing"
  | "ready"
  | "failed"
  | "skipped";

export type NotebookDto = {
  id: string;
  title: string;
  locked: boolean;
  indexStatus: NotebookIndexStatus;
  indexMessage: string | null;
  unitCount: number;
  embeddedCount: number;
  indexedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const NOTEBOOK_SELECT =
  "id,title,locked,index_status,index_message,unit_count,embedded_count,indexed_at,created_at,updated_at";
const NOTEBOOK_SELECT_LEGACY = "id,title,created_at,updated_at";

function asIndexStatus(v: unknown): NotebookIndexStatus {
  const s = String(v || "none");
  if (
    s === "none" ||
    s === "indexing" ||
    s === "ready" ||
    s === "failed" ||
    s === "skipped"
  ) {
    return s;
  }
  return "none";
}

function mapNotebookRow(r: Record<string, unknown>, fallbackNow?: string): NotebookDto {
  const title = String(r.title);
  return {
    id: String(r.id),
    title,
    locked: Boolean(r.locked) || isProtectedDatasetTitle(title),
    indexStatus: asIndexStatus(r.index_status ?? r.indexStatus),
    indexMessage:
      r.index_message != null
        ? String(r.index_message)
        : r.indexMessage != null
          ? String(r.indexMessage)
          : null,
    unitCount: Number(r.unit_count ?? r.unitCount ?? 0) || 0,
    embeddedCount: Number(r.embedded_count ?? r.embeddedCount ?? 0) || 0,
    indexedAt: r.indexed_at
      ? toIso(r.indexed_at)
      : r.indexedAt
        ? toIso(r.indexedAt)
        : null,
    createdAt: toIso(r.created_at ?? r.createdAt, fallbackNow),
    updatedAt: toIso(r.updated_at ?? r.updatedAt, fallbackNow),
  };
}

function mapMemNotebook(row: MemNotebook): NotebookDto {
  return {
    id: row.id,
    title: row.title,
    locked: row.locked || isProtectedDatasetTitle(row.title),
    indexStatus: asIndexStatus(row.indexStatus),
    indexMessage: row.indexMessage,
    unitCount: row.unitCount,
    embeddedCount: row.embeddedCount,
    indexedAt: row.indexedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isMissingLockColumns(error: unknown) {
  const text =
    typeof error === "string"
      ? error
      : error && typeof error === "object"
        ? JSON.stringify(error)
        : "";
  return (
    (text.includes("locked") ||
      text.includes("index_status") ||
      text.includes("unit_count") ||
      text.includes("embedded_count")) &&
    (text.includes("42703") ||
      text.includes("PGRST204") ||
      text.includes("schema cache") ||
      text.includes("does not exist") ||
      text.includes("Could not find"))
  );
}

function isMissingSourceCharCountColumn(error: unknown) {
  const text =
    typeof error === "string"
      ? error
      : error && typeof error === "object"
        ? JSON.stringify(error)
        : "";
  return (
    text.includes("char_count") &&
    /42703|PGRST204|schema cache|does not exist|Could not find/i.test(text)
  );
}

export async function listNotebooks(): Promise<NotebookDto[]> {
  assertDurableDb("List notebooks");
  if (!hasDb()) {
    return Array.from(memNotebooks.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(mapMemNotebook);
  }

  const sb = getSupabaseAdmin();
  if (sb) {
    const { data, error } = await sb
      .from("notebooks")
      .select(NOTEBOOK_SELECT)
      .order("created_at", { ascending: false });
    if (error && isMissingLockColumns(error)) {
      const legacy = await sb
        .from("notebooks")
        .select(NOTEBOOK_SELECT_LEGACY)
        .order("created_at", { ascending: false });
      if (legacy.error) {
        throw new Error(`List notebooks failed: ${sbError(legacy.error)}`);
      }
      return (legacy.data || []).map((r) =>
        mapNotebookRow(r as Record<string, unknown>),
      );
    }
    if (error) throw new Error(`List notebooks failed: ${sbError(error)}`);
    return (data || []).map((r) => mapNotebookRow(r as Record<string, unknown>));
  }

  try {
    const db = getDb();
    const rows = await db.select().from(notebooks).orderBy(desc(notebooks.createdAt));
    return rows.map((r) =>
      mapNotebookRow({
        id: r.id,
        title: r.title,
        locked: r.locked,
        index_status: r.indexStatus,
        index_message: r.indexMessage,
        unit_count: r.unitCount,
        embedded_count: r.embeddedCount,
        indexed_at: r.indexedAt,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
      }),
    );
  } catch (err) {
    throw enrichDbError(err, "List notebooks");
  }
}

export async function createNotebook(title: string): Promise<NotebookDto> {
  assertDurableDb("Create notebook");
  const clean = title.trim();
  if (!clean) throw new Error("Title is required");

  const id = randomUUID();
  const now = new Date().toISOString();

  if (!hasDb()) {
    const row: MemNotebook = {
      id,
      title: clean,
      locked: false,
      indexStatus: "none",
      indexMessage: null,
      unitCount: 0,
      embeddedCount: 0,
      indexedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    memNotebooks.set(id, row);
    return mapMemNotebook(row);
  }

  const sb = getSupabaseAdmin();
  if (sb) {
    const payload = {
      id,
      title: clean,
      locked: false,
      index_status: "none",
      index_message: null,
      unit_count: 0,
      embedded_count: 0,
      indexed_at: null,
      created_at: now,
      updated_at: now,
    };
    const { data, error } = await sb
      .from("notebooks")
      .insert(payload)
      .select(NOTEBOOK_SELECT)
      .single();

    if (error && isMissingLockColumns(error)) {
      const legacy = await sb
        .from("notebooks")
        .insert({ id, title: clean, created_at: now, updated_at: now })
        .select(NOTEBOOK_SELECT_LEGACY)
        .single();
      if (legacy.error) {
        throw new Error(
          `Supabase insert failed (${dbBackend()}): ${sbError(legacy.error)}`,
        );
      }
      return mapNotebookRow(legacy.data as Record<string, unknown>, now);
    }

    if (error) {
      throw new Error(
        `Supabase insert failed (${dbBackend()}): ${sbError(error)}. ` +
          `If table missing, run web/drizzle/0000_init.sql (+ 0005) in Supabase SQL Editor.`,
      );
    }

    return mapNotebookRow(data as Record<string, unknown>, now);
  }

  try {
    const db = getDb();
    await db.insert(notebooks).values({
      id,
      title: clean,
      locked: false,
      indexStatus: "none",
      indexMessage: null,
      unitCount: 0,
      embeddedCount: 0,
      indexedAt: null,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
  } catch (err) {
    throw enrichDbError(err, "Create notebook");
  }

  return {
    id,
    title: clean,
    locked: false,
    indexStatus: "none",
    indexMessage: null,
    unitCount: 0,
    embeddedCount: 0,
    indexedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function getNotebook(id: string): Promise<NotebookDto | null> {
  assertDurableDb("Get notebook");
  if (!hasDb()) {
    const row = memNotebooks.get(id);
    return row ? mapMemNotebook(row) : null;
  }

  const sb = getSupabaseAdmin();
  if (sb) {
    const { data, error } = await sb
      .from("notebooks")
      .select(NOTEBOOK_SELECT)
      .eq("id", id)
      .maybeSingle();
    if (error && isMissingLockColumns(error)) {
      const legacy = await sb
        .from("notebooks")
        .select(NOTEBOOK_SELECT_LEGACY)
        .eq("id", id)
        .maybeSingle();
      if (legacy.error) {
        throw new Error(`Get notebook failed: ${sbError(legacy.error)}`);
      }
      if (!legacy.data) return null;
      return mapNotebookRow(legacy.data as Record<string, unknown>);
    }
    if (error) throw new Error(`Get notebook failed: ${sbError(error)}`);
    if (!data) return null;
    return mapNotebookRow(data as Record<string, unknown>);
  }

  const db = getDb();
  const rows = await db.select().from(notebooks).where(eq(notebooks.id, id)).limit(1);
  const r = rows[0];
  if (!r) return null;
  return mapNotebookRow({
    id: r.id,
    title: r.title,
    locked: r.locked,
    index_status: r.indexStatus,
    index_message: r.indexMessage,
    unit_count: r.unitCount,
    embedded_count: r.embeddedCount,
    indexed_at: r.indexedAt,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  });
}

export async function updateNotebook(
  id: string,
  patch: { title?: string; locked?: boolean },
): Promise<NotebookDto | null> {
  assertDurableDb("Update notebook");
  const existing = await getNotebook(id);
  if (!existing) return null;
  const now = new Date().toISOString();

  let nextTitle = existing.title;
  if (patch.title !== undefined) {
    const clean = patch.title.trim();
    if (!clean) throw new Error("Title is required");
    if (clean.length > 200) throw new Error("Title is too long (max 200)");
    nextTitle = clean;
  }
  // Protected datasets remain locked even if a client attempts to unlock them
  // or renames them. This keeps the delete guard effective after a rename.
  const nextLocked =
    existing.locked ||
    isProtectedDatasetTitle(existing.title) ||
    isProtectedDatasetTitle(nextTitle) ||
    Boolean(patch.locked);

  if (!hasDb()) {
    const row = memNotebooks.get(id);
    if (!row) return null;
    row.title = nextTitle;
    row.locked = nextLocked;
    row.updatedAt = now;
    memNotebooks.set(id, row);
    return mapMemNotebook(row);
  }

  const sb = getSupabaseAdmin();
  if (sb) {
    const body: Record<string, unknown> = {
      title: nextTitle,
      updated_at: now,
    };
    if (patch.locked !== undefined) body.locked = nextLocked;

    const { data, error } = await sb
      .from("notebooks")
      .update(body)
      .eq("id", id)
      .select(NOTEBOOK_SELECT)
      .maybeSingle();

    if (error && isMissingLockColumns(error)) {
      const legacy = await sb
        .from("notebooks")
        .update({ title: nextTitle, updated_at: now })
        .eq("id", id)
        .select(NOTEBOOK_SELECT_LEGACY)
        .maybeSingle();
      if (legacy.error) {
        throw new Error(`Update notebook failed: ${sbError(legacy.error)}`);
      }
      if (!legacy.data) return null;
      const mapped = mapNotebookRow(legacy.data as Record<string, unknown>, now);
      if (patch.locked !== undefined) {
        throw new Error(
          "Dataset lock requires migration web/drizzle/0005_notebook_lock_index.sql",
        );
      }
      return mapped;
    }
    if (error) throw new Error(`Update notebook failed: ${sbError(error)}`);
    if (!data) return null;
    return mapNotebookRow(data as Record<string, unknown>, now);
  }

  try {
    const db = getDb();
    await db
      .update(notebooks)
      .set({
        title: nextTitle,
        locked: nextLocked,
        updatedAt: new Date(now),
      })
      .where(eq(notebooks.id, id));
  } catch (err) {
    throw enrichDbError(err, "Update notebook");
  }

  return {
    ...existing,
    title: nextTitle,
    locked: nextLocked,
    updatedAt: now,
  };
}

/** Persist embed index status after upload indexing (Supabase Postgres). */
export async function updateNotebookIndexMeta(
  id: string,
  meta: {
    indexStatus: NotebookIndexStatus;
    indexMessage?: string | null;
    unitCount?: number;
    embeddedCount?: number;
    indexedAt?: string | null;
  },
): Promise<void> {
  assertDurableDb("Update notebook index meta");
  const now = new Date().toISOString();

  if (!hasDb()) {
    const row = memNotebooks.get(id);
    if (!row) return;
    row.indexStatus = meta.indexStatus;
    if (meta.indexMessage !== undefined) row.indexMessage = meta.indexMessage;
    if (meta.unitCount !== undefined) row.unitCount = meta.unitCount;
    if (meta.embeddedCount !== undefined) row.embeddedCount = meta.embeddedCount;
    if (meta.indexedAt !== undefined) row.indexedAt = meta.indexedAt;
    row.updatedAt = now;
    memNotebooks.set(id, row);
    return;
  }

  const sb = getSupabaseAdmin();
  if (sb) {
    const body: Record<string, unknown> = {
      index_status: meta.indexStatus,
      updated_at: now,
    };
    if (meta.indexMessage !== undefined) body.index_message = meta.indexMessage;
    if (meta.unitCount !== undefined) body.unit_count = meta.unitCount;
    if (meta.embeddedCount !== undefined) body.embedded_count = meta.embeddedCount;
    if (meta.indexedAt !== undefined) body.indexed_at = meta.indexedAt;

    const { error } = await sb.from("notebooks").update(body).eq("id", id);
    if (error && !isMissingLockColumns(error)) {
      console.warn("[index meta]", sbError(error));
    }
    return;
  }

  try {
    const db = getDb();
    await db
      .update(notebooks)
      .set({
        indexStatus: meta.indexStatus,
        indexMessage: meta.indexMessage ?? null,
        unitCount: meta.unitCount,
        embeddedCount: meta.embeddedCount,
        indexedAt: meta.indexedAt ? new Date(meta.indexedAt) : null,
        updatedAt: new Date(now),
      })
      .where(eq(notebooks.id, id));
  } catch (err) {
    console.warn("[index meta]", err);
  }
}

export async function deleteNotebook(id: string) {
  assertDurableDb("Delete notebook");
  const existing = await getNotebook(id);
  if (!existing) return;
  if (existing.locked || isProtectedDatasetTitle(existing.title)) {
    throw new Error(
      "This dataset is locked. Unlock it first if you really want to delete it.",
    );
  }

  if (!hasDb()) {
    memNotebooks.delete(id);
    for (const [sid, s] of memSources) {
      if (s.notebookId === id) memSources.delete(sid);
    }
    for (const [cid, c] of memChunks) {
      if (c.notebookId === id) memChunks.delete(cid);
    }
    invalidateNotebookRetrievalCache(id);
    return;
  }

  const sb = getSupabaseAdmin();
  if (sb) {
    // Parallel child deletes, then parent — lower wall-clock for large corpora
    const [chunksRes, sourcesRes, messagesRes] = await Promise.all([
      sb.from("chunks").delete().eq("notebook_id", id),
      sb.from("sources").delete().eq("notebook_id", id),
      // Best-effort: table may be missing on older projects
      sb.from("notebook_messages").delete().eq("notebook_id", id),
    ]);
    if (chunksRes.error) {
      throw new Error(`Delete chunks failed: ${sbError(chunksRes.error)}`);
    }
    if (sourcesRes.error) {
      throw new Error(`Delete sources failed: ${sbError(sourcesRes.error)}`);
    }
    void messagesRes; // ignore missing notebook_messages
    const { error } = await sb.from("notebooks").delete().eq("id", id);
    if (error) throw new Error(`Delete notebook failed: ${sbError(error)}`);
    invalidateNotebookRetrievalCache(id);
    return;
  }

  const db = getDb();
  await Promise.all([
    db.delete(chunks).where(eq(chunks.notebookId, id)),
    db.delete(sources).where(eq(sources.notebookId, id)),
  ]);
  await db.delete(notebooks).where(eq(notebooks.id, id));
  invalidateNotebookRetrievalCache(id);
}

/** Full source text for indexing (not the lightweight listSources DTO). */
export async function listSourcesForIndex(
  notebookId: string,
  sourceIds?: string[],
): Promise<
  Array<{
    id: string;
    notebookId: string;
    title: string;
    mime: string | null;
    text: string;
  }>
> {
  assertDurableDb("List sources for index");
  if (!hasDb()) {
    return Array.from(memSources.values())
      .filter(
        (s) =>
          s.notebookId === notebookId &&
          (!sourceIds?.length || sourceIds.includes(s.id)),
      )
      .map((s) => ({
        id: s.id,
        notebookId: s.notebookId,
        title: s.title,
        mime: s.mime,
        text: s.text,
      }));
  }

  const sb = getSupabaseAdmin();
  if (sb) {
    let query = sb
      .from("sources")
      .select("id,notebook_id,title,mime,text")
      .eq("notebook_id", notebookId);
    if (sourceIds?.length) query = query.in("id", sourceIds);
    const { data, error } = await query;
    if (error) throw new Error(`List sources failed: ${sbError(error)}`);
    return (data || []).map((s) => ({
      id: s.id as string,
      notebookId: s.notebook_id as string,
      title: s.title as string,
      mime: (s.mime as string | null) ?? null,
      text: String(s.text || ""),
    }));
  }

  const db = getDb();
  const conditions = [eq(sources.notebookId, notebookId)];
  if (sourceIds?.length) conditions.push(inArray(sources.id, sourceIds));
  const rows = await db
    .select()
    .from(sources)
    .where(and(...conditions));
  return rows.map((s) => ({
    id: s.id,
    notebookId: s.notebookId,
    title: s.title,
    mime: s.mime,
    text: s.text,
  }));
}

export type ChunkWriteRow = {
  id: string;
  sourceId: string;
  notebookId: string;
  chunkIndex: number;
  text: string;
  embedding: number[] | null;
  embeddingModel: string | null;
};

const CHUNK_WRITE_BATCH_SIZE = 40;
const CHUNK_WRITE_CONCURRENCY = 3;

/** Bounded parallel writes: faster on high-latency Supabase without a burst. */
async function runBoundedBatches<T>(
  items: T[],
  write: (batch: T[]) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const batches = Array.from(
    { length: Math.ceil(items.length / CHUNK_WRITE_BATCH_SIZE) },
    (_, index) =>
      items.slice(
        index * CHUNK_WRITE_BATCH_SIZE,
        (index + 1) * CHUNK_WRITE_BATCH_SIZE,
      ),
  );
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      await write(batch);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(CHUNK_WRITE_CONCURRENCY, batches.length) },
      () => worker(),
    ),
  );
}

/** Replace all chunk rows for a notebook (pre-computed embeddings). */
export async function replaceNotebookChunks(
  notebookId: string,
  rows: ChunkWriteRow[],
): Promise<void> {
  assertDurableDb("Replace notebook chunks");

  if (!hasDb()) {
    for (const [cid, c] of memChunks) {
      if (c.notebookId === notebookId) memChunks.delete(cid);
    }
    for (const r of rows) {
      memChunks.set(r.id, {
        id: r.id,
        sourceId: r.sourceId,
        notebookId: r.notebookId,
        chunkIndex: r.chunkIndex,
        text: r.text,
        embedding: r.embedding,
        embeddingModel: r.embeddingModel,
      });
    }
    invalidateNotebookRetrievalCache(notebookId);
    return;
  }

  const sb = getSupabaseAdmin();
  if (sb) {
    const { error: delErr } = await sb
      .from("chunks")
      .delete()
      .eq("notebook_id", notebookId);
    if (delErr) throw new Error(`Clear chunks failed: ${sbError(delErr)}`);
    if (!rows.length) {
      invalidateNotebookRetrievalCache(notebookId);
      return;
    }

    const payload = rows.map((r) => ({
      id: r.id,
      source_id: r.sourceId,
      notebook_id: r.notebookId,
      chunk_index: r.chunkIndex,
      text: r.text,
      embedding_json: r.embedding,
      embedding_model: r.embeddingModel,
    }));
    await runBoundedBatches(payload, async (batch) => {
      const { error } = await sb.from("chunks").insert(batch);
      if (error) {
        // Retry without embedding columns if schema lag
        if (isMissingEmbeddingColumn(error)) {
          const legacy = batch.map((p) => ({
            id: p.id,
            source_id: p.source_id,
            notebook_id: p.notebook_id,
            chunk_index: p.chunk_index,
            text: p.text,
          }));
          const leg = await sb.from("chunks").insert(legacy);
          if (leg.error) {
            throw new Error(`Insert chunks failed: ${sbError(leg.error)}`);
          }
        } else {
          throw new Error(`Insert chunks failed: ${sbError(error)}`);
        }
      }
    });
    invalidateNotebookRetrievalCache(notebookId);
    return;
  }

  const db = getDb();
  await db.delete(chunks).where(eq(chunks.notebookId, notebookId));
  if (!rows.length) {
    invalidateNotebookRetrievalCache(notebookId);
    return;
  }
  await db.insert(chunks).values(
    rows.map((r) => ({
      id: r.id,
      sourceId: r.sourceId,
      notebookId: r.notebookId,
      chunkIndex: r.chunkIndex,
      text: r.text,
      embeddingJson: r.embedding,
      embeddingModel: r.embeddingModel,
    })),
  );
  invalidateNotebookRetrievalCache(notebookId);
}

/**
 * Replace chunks for only the supplied sources. Upload processing uses this
 * path so adding one document does not re-embed and rewrite the whole notebook.
 */
export async function replaceNotebookChunksForSources(
  notebookId: string,
  sourceIds: string[],
  rows: ChunkWriteRow[],
): Promise<void> {
  assertDurableDb("Replace source chunks");
  const ids = [...new Set(sourceIds.filter(Boolean))];
  if (ids.length === 0) return replaceNotebookChunks(notebookId, rows);

  if (!hasDb()) {
    for (const [cid, c] of memChunks) {
      if (c.notebookId === notebookId && ids.includes(c.sourceId)) {
        memChunks.delete(cid);
      }
    }
    for (const r of rows) {
      memChunks.set(r.id, {
        id: r.id,
        sourceId: r.sourceId,
        notebookId: r.notebookId,
        chunkIndex: r.chunkIndex,
        text: r.text,
        embedding: r.embedding,
        embeddingModel: r.embeddingModel,
      });
    }
    invalidateNotebookRetrievalCache(notebookId);
    return;
  }

  const payload = rows.map((r) => ({
    id: r.id,
    source_id: r.sourceId,
    notebook_id: r.notebookId,
    chunk_index: r.chunkIndex,
    text: r.text,
    embedding_json: r.embedding,
    embedding_model: r.embeddingModel,
  }));
  const sb = getSupabaseAdmin();
  if (sb) {
    const { error: delErr } = await sb
      .from("chunks")
      .delete()
      .eq("notebook_id", notebookId)
      .in("source_id", ids);
    if (delErr) throw new Error(`Clear source chunks failed: ${sbError(delErr)}`);
    await runBoundedBatches(payload, async (batch) => {
      const { error } = await sb.from("chunks").insert(batch);
      if (!error) return;
      if (!isMissingEmbeddingColumn(error)) {
        throw new Error(`Insert source chunks failed: ${sbError(error)}`);
      }
      const legacy = batch.map((p) => ({
        id: p.id,
        source_id: p.source_id,
        notebook_id: p.notebook_id,
        chunk_index: p.chunk_index,
        text: p.text,
      }));
      const retry = await sb.from("chunks").insert(legacy);
      if (retry.error) throw new Error(`Insert source chunks failed: ${sbError(retry.error)}`);
    });
    invalidateNotebookRetrievalCache(notebookId);
    return;
  }

  const db = getDb();
  await db
    .delete(chunks)
    .where(and(eq(chunks.notebookId, notebookId), inArray(chunks.sourceId, ids)));
  if (rows.length) {
    await db.insert(chunks).values(
      rows.map((r) => ({
        id: r.id,
        sourceId: r.sourceId,
        notebookId: r.notebookId,
        chunkIndex: r.chunkIndex,
        text: r.text,
        embeddingJson: r.embedding,
        embeddingModel: r.embeddingModel,
      })),
    );
  }
  invalidateNotebookRetrievalCache(notebookId);
}

export async function listSources(notebookId: string) {
  assertDurableDb('List sources');
  if (!hasDb()) {
    return Array.from(memSources.values())
      .filter((s) => s.notebookId === notebookId)
      .map((s) => ({
        id: s.id,
        notebookId: s.notebookId,
        title: s.title,
        mime: s.mime,
        charCount: s.text.length,
        createdAt: s.createdAt,
      }));
  }

  const sb = getSupabaseAdmin();
  if (sb) {
    // Do not select `text` here. This endpoint feeds the workspace/sidebar and
    // used to transfer every full PDF on every notebook open just to compute
    // character counts. Migration 0007 stores that scalar separately.
    const { data, error } = await sb
      .from("sources")
      .select("id,notebook_id,title,mime,char_count,created_at")
      .eq("notebook_id", notebookId)
      .order("created_at", { ascending: false });
    if (error && isMissingSourceCharCountColumn(error)) {
      // Older deployments remain compatible until migration 0007 is applied.
      const legacy = await sb
        .from("sources")
        .select("id,notebook_id,title,mime,text,created_at")
        .eq("notebook_id", notebookId)
        .order("created_at", { ascending: false });
      if (legacy.error) throw new Error(`List sources failed: ${sbError(legacy.error)}`);
      return (legacy.data || []).map((s) => ({
        id: s.id as string,
        notebookId: s.notebook_id as string,
        title: s.title as string,
        mime: (s.mime as string | null) ?? null,
        charCount: String(s.text || "").length,
        createdAt: toIso(s.created_at),
      }));
    }
    if (error) throw new Error(`List sources failed: ${sbError(error)}`);
    return (data || []).map((s) => ({
      id: s.id as string,
      notebookId: s.notebook_id as string,
      title: s.title as string,
      mime: (s.mime as string | null) ?? null,
      charCount: Number(s.char_count) || 0,
      createdAt: toIso(s.created_at),
    }));
  }

  const db = getDb();
  let rows: Array<{
    id: string;
    notebookId: string;
    title: string;
    mime: string | null;
    charCount: number | null;
    text: string;
    createdAt: Date;
  }>;
  try {
    rows = await db
      .select({
        id: sources.id,
        notebookId: sources.notebookId,
        title: sources.title,
        mime: sources.mime,
        charCount: sources.charCount,
        text: sources.text,
        createdAt: sources.createdAt,
      })
      .from(sources)
      .where(eq(sources.notebookId, notebookId));
  } catch (error) {
    if (!isMissingSourceCharCountColumn(error)) throw error;
    // Keep direct-Postgres deployments on the pre-0007 schema usable while
    // their additive migration is being applied.
    const legacyRows = await db
      .select({
        id: sources.id,
        notebookId: sources.notebookId,
        title: sources.title,
        mime: sources.mime,
        text: sources.text,
        createdAt: sources.createdAt,
      })
      .from(sources)
      .where(eq(sources.notebookId, notebookId));
    rows = legacyRows.map((row) => ({ ...row, charCount: null }));
  }
  return rows.map((s) => ({
    id: s.id,
    notebookId: s.notebookId,
    title: s.title,
    mime: s.mime,
    charCount: s.charCount ?? s.text.length,
    createdAt: toIso(s.createdAt),
  }));
}

/** Full source text + chunks for document detail drawer */
export async function getSourceDetail(notebookId: string, sourceId: string) {
  assertDurableDb('Get source');
  if (!hasDb()) {
    const source = memSources.get(sourceId);
    if (!source || source.notebookId !== notebookId) return null;
    const sourceChunks = Array.from(memChunks.values())
      .filter((c) => c.sourceId === sourceId)
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .map((c) => ({
        chunkId: c.id,
        chunkIndex: c.chunkIndex,
        text: c.text,
      }));
    return {
      id: source.id,
      notebookId: source.notebookId,
      title: source.title,
      mime: source.mime,
      text: source.text,
      charCount: source.text.length,
      createdAt: source.createdAt,
      chunks: sourceChunks,
    };
  }

  const sb = getSupabaseAdmin();
  if (sb) {
    const { data: source, error } = await sb
      .from("sources")
      .select("id,notebook_id,title,mime,text,created_at")
      .eq("id", sourceId)
      .eq("notebook_id", notebookId)
      .maybeSingle();
    if (error) throw new Error(`Load source failed: ${sbError(error)}`);
    if (!source) return null;

    const { data: chunkRows, error: cErr } = await sb
      .from("chunks")
      .select("id,chunk_index,text")
      .eq("source_id", sourceId)
      .eq("notebook_id", notebookId)
      .order("chunk_index", { ascending: true });
    if (cErr) throw new Error(`Load source chunks failed: ${sbError(cErr)}`);

    const text = String(source.text || "");
    return {
      id: source.id as string,
      notebookId: source.notebook_id as string,
      title: source.title as string,
      mime: (source.mime as string | null) ?? null,
      text,
      charCount: text.length,
      createdAt: toIso(source.created_at),
      chunks: (chunkRows || []).map((c) => ({
        chunkId: c.id as string,
        chunkIndex: c.chunk_index as number,
        text: c.text as string,
      })),
    };
  }

  const db = getDb();
  const [source] = await db
    .select()
    .from(sources)
    .where(eq(sources.id, sourceId));
  if (!source || source.notebookId !== notebookId) return null;

  const chunkRows = await db
    .select()
    .from(chunks)
    .where(eq(chunks.sourceId, sourceId));
  chunkRows.sort((a, b) => a.chunkIndex - b.chunkIndex);

  return {
    id: source.id,
    notebookId: source.notebookId,
    title: source.title,
    mime: source.mime,
    text: source.text,
    charCount: source.text.length,
    createdAt: toIso(source.createdAt),
    chunks: chunkRows.map((c) => ({
      chunkId: c.id,
      chunkIndex: c.chunkIndex,
      text: c.text,
    })),
  };
}

/**
 * Persist progress for raw-only ingest.
 * Chunk/embed are intentionally not part of storage.
 */
export type SourceProgressEvent = { stage: "store"; ms: number };

export type AddSourceResult = {
  id: string;
  title: string;
  /** Always 0 for new ingest — raw sources only, no chunk rows written. */
  chunkCount: 0;
  charCount: number;
  timing: { storeMs: number };
  embeddedCount: 0;
  mode: "raw-sources-only";
};

/**
 * Store full document text in `sources` only.
 * No chunking, no embedding, no IR preprocessing at ingest time.
 */
export async function addSource(
  params: {
    notebookId: string;
    title: string;
    mime: string | null;
    text: string;
  },
  onProgress?: (event: SourceProgressEvent) => void,
): Promise<AddSourceResult> {
  assertDurableDb("Add source");
  const notebook = await getNotebook(params.notebookId);
  if (!notebook) throw new Error("Notebook not found");

  const existing = await listSources(params.notebookId);
  const usedChars = existing.reduce((n, s) => n + s.charCount, 0);
  const incoming = params.text.length;
  const totalChars = usedChars + incoming;
  const limit = IR_DEFAULTS.maxNotebookChars;

  if (totalChars > limit) {
    const room = Math.max(0, limit - usedChars);
    throw new Error(
      `Notebook text limit exceeded: this file is ${incoming.toLocaleString()} chars, ` +
        `dataset already has ${usedChars.toLocaleString()}, total would be ` +
        `${totalChars.toLocaleString()} (max ${limit.toLocaleString()}). ` +
        (room > 0
          ? `About ${room.toLocaleString()} chars free — use a smaller file, split into a new dataset, or raise MAX_NOTEBOOK_CHARS.`
          : `No room left in this dataset — open a new dataset for additional documents, or raise MAX_NOTEBOOK_CHARS.`),
    );
  }

  const sourceId = randomUUID();
  const now = new Date().toISOString();
  const storeStart = Date.now();

  if (!hasDb()) {
    const source: MemSource = {
      id: sourceId,
      notebookId: params.notebookId,
      title: params.title,
      mime: params.mime,
      text: params.text,
      createdAt: now,
    };
    memSources.set(sourceId, source);
    // deliberately no memChunks writes
    invalidateNotebookRetrievalCache(params.notebookId);
    const storeMs = Date.now() - storeStart;
    onProgress?.({ stage: "store", ms: storeMs });
    return {
      id: sourceId,
      title: params.title,
      chunkCount: 0,
      charCount: params.text.length,
      timing: { storeMs },
      embeddedCount: 0,
      mode: "raw-sources-only",
    };
  }

  const sb = getSupabaseAdmin();
  if (sb) {
    const { error: sErr } = await sb.from("sources").insert({
      id: sourceId,
      notebook_id: params.notebookId,
      title: params.title,
      mime: params.mime,
      text: params.text,
      char_count: params.text.length,
      created_at: now,
    });
    if (sErr && isMissingSourceCharCountColumn(sErr)) {
      const legacy = await sb.from("sources").insert({
        id: sourceId,
        notebook_id: params.notebookId,
        title: params.title,
        mime: params.mime,
        text: params.text,
        created_at: now,
      });
      if (legacy.error) throw new Error(`Save source failed: ${sbError(legacy.error)}`);
    } else if (sErr) {
      throw new Error(`Save source failed: ${sbError(sErr)}`);
    }

    invalidateNotebookRetrievalCache(params.notebookId);
    const storeMs = Date.now() - storeStart;
    onProgress?.({ stage: "store", ms: storeMs });
    return {
      id: sourceId,
      title: params.title,
      chunkCount: 0,
      charCount: params.text.length,
      timing: { storeMs },
      embeddedCount: 0,
      mode: "raw-sources-only",
    };
  }

  const db = getDb();
  try {
    await db.insert(sources).values({
      id: sourceId,
      notebookId: params.notebookId,
      title: params.title,
      mime: params.mime,
      text: params.text,
      charCount: params.text.length,
      createdAt: new Date(now),
    });
  } catch (error) {
    if (!isMissingSourceCharCountColumn(error)) throw error;
    await db.insert(sources).values({
      id: sourceId,
      notebookId: params.notebookId,
      title: params.title,
      mime: params.mime,
      text: params.text,
      createdAt: new Date(now),
    });
  }

  invalidateNotebookRetrievalCache(params.notebookId);
  const storeMs = Date.now() - storeStart;
  onProgress?.({ stage: "store", ms: storeMs });
  return {
    id: sourceId,
    title: params.title,
    chunkCount: 0,
    charCount: params.text.length,
    timing: { storeMs },
    embeddedCount: 0,
    mode: "raw-sources-only",
  };
}

export async function renameSource(
  notebookId: string,
  sourceId: string,
  title: string,
) {
  assertDurableDb("Rename source");
  const notebook = await getNotebook(notebookId);
  if (!notebook) throw new Error("Notebook not found");
  const clean = title.trim();
  if (!clean) throw new Error("Source name is required");
  if (clean.length > 200) throw new Error("Source name is too long (max 200)");

  if (!hasDb()) {
    const source = memSources.get(sourceId);
    if (!source || source.notebookId !== notebookId) return null;
    source.title = clean;
    memSources.set(sourceId, source);
    invalidateNotebookRetrievalCache(notebookId);
    return {
      id: source.id,
      notebookId: source.notebookId,
      title: source.title,
      mime: source.mime,
      charCount: source.text.length,
      createdAt: source.createdAt,
    };
  }

  const now = new Date().toISOString();
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data, error } = await sb
      .from("sources")
      .update({ title: clean })
      .eq("id", sourceId)
      .eq("notebook_id", notebookId)
      .select("id,notebook_id,title,mime,text,created_at")
      .maybeSingle();
    if (error) throw new Error(`Rename source failed: ${sbError(error)}`);
    if (!data) return null;
    invalidateNotebookRetrievalCache(notebookId);
    return {
      id: data.id as string,
      notebookId: data.notebook_id as string,
      title: data.title as string,
      mime: (data.mime as string | null) ?? null,
      charCount: String(data.text || "").length,
      createdAt: toIso(data.created_at, now),
    };
  }

  const db = getDb();
  const [updated] = await db
    .update(sources)
    .set({ title: clean })
    .where(eq(sources.id, sourceId))
    .returning();
  if (!updated || updated.notebookId !== notebookId) return null;
  invalidateNotebookRetrievalCache(notebookId);
  return {
    id: updated.id,
    notebookId: updated.notebookId,
    title: updated.title,
    mime: updated.mime,
    charCount: updated.text.length,
    createdAt: toIso(updated.createdAt, now),
  };
}

export async function deleteSource(notebookId: string, sourceId: string) {
  assertDurableDb("Delete source");
  const notebook = await getNotebook(notebookId);
  if (!notebook) throw new Error("Notebook not found");

  if (!hasDb()) {
    const source = memSources.get(sourceId);
    if (!source || source.notebookId !== notebookId) return false;
    memSources.delete(sourceId);
    for (const [chunkId, chunk] of memChunks) {
      if (chunk.sourceId === sourceId && chunk.notebookId === notebookId) {
        memChunks.delete(chunkId);
      }
    }
    invalidateNotebookRetrievalCache(notebookId);
    return true;
  }

  const sb = getSupabaseAdmin();
  if (sb) {
    const chunksResult = await sb
      .from("chunks")
      .delete()
      .eq("source_id", sourceId)
      .eq("notebook_id", notebookId);
    if (chunksResult.error) {
      throw new Error(`Delete source index failed: ${sbError(chunksResult.error)}`);
    }
    const sourceResult = await sb
      .from("sources")
      .delete()
      .eq("id", sourceId)
      .eq("notebook_id", notebookId)
      .select("id")
      .maybeSingle();
    if (sourceResult.error) {
      throw new Error(`Delete source failed: ${sbError(sourceResult.error)}`);
    }
    invalidateNotebookRetrievalCache(notebookId);
    return Boolean(sourceResult.data);
  }

  const db = getDb();
  await db
    .delete(chunks)
    .where(and(eq(chunks.sourceId, sourceId), eq(chunks.notebookId, notebookId)));
  const deleted = await db
    .delete(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.notebookId, notebookId)))
    .returning({ id: sources.id, notebookId: sources.notebookId });
  invalidateNotebookRetrievalCache(notebookId);
  return deleted[0]?.notebookId === notebookId;
}

/** Count stored chunk rows (legacy corpora only; raw ingest writes 0). */
export async function countChunks(notebookId: string) {
  if (!hasDb()) {
    return Array.from(memChunks.values()).filter((c) => c.notebookId === notebookId)
      .length;
  }

  const sb = getSupabaseAdmin();
  if (sb) {
    const { count, error } = await sb
      .from("chunks")
      .select("id", { count: "exact", head: true })
      .eq("notebook_id", notebookId);
    if (error) throw new Error(`Count chunks failed: ${sbError(error)}`);
    return count || 0;
  }

  const db = getDb();
  const rows = await db
    .select({ id: chunks.id })
    .from(chunks)
    .where(eq(chunks.notebookId, notebookId));
  return rows.length;
}

/** Counts used for notebook index metadata without transferring chunk text. */
export async function getChunkStats(
  notebookId: string,
  options: { includeSourceCoverage?: boolean } = {},
): Promise<{
  unitCount: number;
  embeddedCount: number;
  sourceCount?: number;
  indexedSourceCount?: number;
}> {
  if (!hasDb()) {
    const rows = Array.from(memChunks.values()).filter(
      (c) => c.notebookId === notebookId,
    );
    const sourceIds = new Set(
      Array.from(memSources.values())
        .filter((s) => s.notebookId === notebookId)
        .map((s) => s.id),
    );
    const indexedSourceIds = new Set(rows.map((row) => row.sourceId));
    return {
      unitCount: rows.length,
      embeddedCount: rows.filter((c) => Boolean(c.embedding?.length)).length,
      ...(options.includeSourceCoverage
        ? {
            sourceCount: sourceIds.size,
            indexedSourceCount: indexedSourceIds.size,
          }
        : {}),
    };
  }

  const sb = getSupabaseAdmin();
  if (sb) {
    const [total, embedded, sourceCount, indexedSources] = await Promise.all([
      sb
        .from("chunks")
        .select("id", { count: "exact", head: true })
        .eq("notebook_id", notebookId),
      sb
        .from("chunks")
        .select("id", { count: "exact", head: true })
        .eq("notebook_id", notebookId)
        .not("embedding_json", "is", null),
      options.includeSourceCoverage
        ? sb
            .from("sources")
            .select("id", { count: "exact", head: true })
            .eq("notebook_id", notebookId)
        : Promise.resolve({ data: null, count: null, error: null }),
      options.includeSourceCoverage
        ? sb.from("chunks").select("source_id").eq("notebook_id", notebookId)
        : Promise.resolve({ data: null, count: null, error: null }),
    ]);
    if (total.error) throw new Error(`Count chunks failed: ${sbError(total.error)}`);
    const indexedSourceCount = options.includeSourceCoverage
      ? new Set(
          ((indexedSources.data || []) as Array<{ source_id?: unknown }>)
            .map((row) => String(row.source_id || ""))
            .filter(Boolean),
        ).size
      : undefined;
    return {
      unitCount: total.count || 0,
      embeddedCount: embedded.error ? 0 : embedded.count || 0,
      ...(options.includeSourceCoverage
        ? {
            sourceCount: sourceCount.count || 0,
            indexedSourceCount,
          }
        : {}),
    };
  }

  const db = getDb();
  const rows = await db
    .select({ id: chunks.id, sourceId: chunks.sourceId, embedding: chunks.embeddingJson })
    .from(chunks)
    .where(eq(chunks.notebookId, notebookId));
  const result = {
    unitCount: rows.length,
    embeddedCount: rows.filter(
      (row) => Array.isArray(row.embedding) && row.embedding.length > 0,
    ).length,
  };
  if (!options.includeSourceCoverage) return result;
  const sourceRows = await db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.notebookId, notebookId));
  return {
    ...result,
    sourceCount: sourceRows.length,
    indexedSourceCount: new Set(rows.map((row) => row.sourceId)).size,
  };
}

/**
 * Load retrieval units for a notebook.
 * Prefer stored chunks when present; if the notebook is raw-only (sources with
 * no chunks), expand each source at query time into record/paragraph units
 * (still no embedding stored — pure on-the-fly split for ranking).
 */
export async function loadChunks(
  notebookId: string,
  sourceIds?: string[],
  options: LoadChunksOptions = {},
): Promise<ChunkWithEmbedding[]> {
  const includeEmbeddings = options.includeEmbeddings !== false;
  const key = retrievalCacheKey(
    notebookId,
    sourceIds,
    includeEmbeddings,
    options.searchQuery,
    options.searchCandidateLimit,
    options.searchMinCandidates,
  );
  const cached = getCachedRetrievalUnits(key);
  if (cached) return cached;
  const running = notebookRetrievalInflight.get(key);
  if (running) return running;

  const epoch = notebookRetrievalEpoch.get(notebookId) || 0;
  const request = loadChunksUncached(notebookId, sourceIds, {
    includeEmbeddings,
    searchQuery: options.searchQuery,
    searchCandidateLimit: options.searchCandidateLimit,
    searchMinCandidates: options.searchMinCandidates,
  })
    .then((chunks) => {
      // A source/index mutation may finish while this request is in flight.
      // Do not repopulate the cache with a stale corpus in that case.
      if ((notebookRetrievalEpoch.get(notebookId) || 0) === epoch) {
        setCachedRetrievalUnits(key, chunks);
      }
      return chunks;
    })
    .finally(() => {
      notebookRetrievalInflight.delete(key);
    });
  notebookRetrievalInflight.set(key, request);
  return request;
}

async function loadChunksUncached(
  notebookId: string,
  sourceIds?: string[],
  options: LoadChunksOptions = {},
): Promise<ChunkWithEmbedding[]> {
  assertDurableDb('Load chunks');
  const includeEmbeddings = options.includeEmbeddings !== false;
  if (!hasDb()) {
    let rows = Array.from(memChunks.values()).filter((c) => c.notebookId === notebookId);
    if (sourceIds?.length) {
      const set = new Set(sourceIds);
      rows = rows.filter((c) => set.has(c.sourceId));
    }
    const sourceMap = new Map(
      Array.from(memSources.values()).map((s) => [s.id, s] as const),
    );
    if (rows.length) {
      // Multi-unit sources: distinct documentId so each claim ranks separately
      const bySource = new Map<string, number>();
      for (const c of rows) {
        bySource.set(c.sourceId, (bySource.get(c.sourceId) || 0) + 1);
      }
      const chunkUnits: ChunkWithEmbedding[] = rows.map((c) => {
        const multi = (bySource.get(c.sourceId) || 0) > 1;
        const baseTitle = sourceMap.get(c.sourceId)?.title || "Source";
        return {
          chunkId: c.id,
          documentId: multi ? `${c.sourceId}#c${c.chunkIndex}` : c.sourceId,
          title: multi
            ? `${baseTitle} · #${c.chunkIndex + 1}`
            : baseTitle,
          text: c.text,
          chunkIndex: c.chunkIndex,
          embedding: c.embedding,
          embeddingModel: c.embeddingModel,
        };
      });
      // Incremental indexing can leave older raw sources without chunks.
      // Keep them in the corpus until they are indexed too.
      const indexedSourceIds = new Set(rows.map((c) => c.sourceId));
      const rawSources = Array.from(memSources.values()).filter(
        (s) =>
          s.notebookId === notebookId &&
          !indexedSourceIds.has(s.id) &&
          (!sourceIds?.length || sourceIds.includes(s.id)),
      );
      return chunkUnits.concat(
        expandRawSourcesToUnits(
          rawSources.map((s) => ({
            id: s.id,
            title: s.title,
            text: s.text,
            mime: s.mime,
          })),
        ),
      );
    }
    // raw sources only — query-time unit expansion
    let srcs = Array.from(memSources.values()).filter(
      (s) => s.notebookId === notebookId,
    );
    if (sourceIds?.length) {
      const set = new Set(sourceIds);
      srcs = srcs.filter((s) => set.has(s.id));
    }
    return expandRawSourcesToUnits(
      srcs.map((s) => ({
        id: s.id,
        title: s.title,
        text: s.text,
        mime: s.mime,
      })),
    );
  }

  const sb = getSupabaseAdmin();
  if (sb) {
    const chunkSelect = includeEmbeddings
      ? "id,source_id,chunk_index,text,embedding_json,embedding_model"
      : "id,source_id,chunk_index,text";
    let q = sb
      .from("chunks")
      .select(chunkSelect)
      .eq("notebook_id", notebookId);
    if (sourceIds?.length) q = q.in("source_id", sourceIds);
    const canUseSearchPrefilter =
      Boolean(options.searchQuery?.trim()) &&
      (options.searchCandidateLimit || 0) > 0;
    let selected;
    let usedChunkSearchPrefilter = false;
    let sourceIdResultPromise:
      | Promise<{ data: Array<{ id: string }> | null; error: unknown }>
      | null = null;
    if (canUseSearchPrefilter) {
      const candidateLimit = Math.max(1, Math.min(options.searchCandidateLimit || 320, 1000));
      let candidateQuery = sb
        .from("chunks")
        .select(chunkSelect)
        .eq("notebook_id", notebookId)
        .textSearch("search_vector", options.searchQuery!.trim(), {
          type: "websearch",
          config: "simple",
        })
        .limit(candidateLimit);
      if (sourceIds?.length) candidateQuery = candidateQuery.in("source_id", sourceIds);
      const candidateResult = await candidateQuery;
      const minCandidates = Math.max(1, options.searchMinCandidates || 1);
      // A small result set can be a false negative for an older schema or a
      // tokenizer edge case. Keep exact legacy behavior in that case.
      if (!candidateResult.error && (candidateResult.data?.length || 0) >= minCandidates) {
        selected = candidateResult;
        usedChunkSearchPrefilter = true;
      }
    }
    // Keep the old full-corpus query as the compatibility path. This is only
    // reached when the FTS column/migration is unavailable, the query cannot
    // be parsed, or the candidate set is too small to safely satisfy topK.
    if (!selected) {
      // The full chunk read and the source-id probe are independent. Start
      // both together so mixed indexed/raw notebooks do not pay an extra
      // network round trip before retrieval can begin.
      sourceIdResultPromise = (async () => {
        let sourceIdQuery = sb
          .from("sources")
          .select("id")
          .eq("notebook_id", notebookId);
        if (sourceIds?.length) sourceIdQuery = sourceIdQuery.in("id", sourceIds);
        try {
          const result = await sourceIdQuery;
          return {
            data: (result.data || []) as Array<{ id: string }>,
            error: result.error,
          };
        } catch (error) {
          return { data: [], error };
        }
      })();
      selected = await q;
    }
    let chunkRows = selected.data as ChunkRow[] | null;
    let error = selected.error;
    let hasEmbeddingColumns = includeEmbeddings;
    if (includeEmbeddings && error && isMissingEmbeddingColumn(error)) {
      hasEmbeddingColumns = false;
      let legacyQuery = sb
        .from("chunks")
        .select("id,source_id,chunk_index,text")
        .eq("notebook_id", notebookId);
      if (sourceIds?.length) legacyQuery = legacyQuery.in("source_id", sourceIds);
      const legacy = await legacyQuery;
      chunkRows = legacy.data as ChunkRow[] | null;
      error = legacy.error;
    }
    if (error) throw new Error(`Load chunks failed: ${sbError(error)}`);

    if (chunkRows && chunkRows.length > 0) {
      const ids = [...new Set(chunkRows.map((c) => c.source_id as string))];
      let sourceMap = new Map<string, string>();
      if (ids.length) {
        const { data: sourceRows } = await sb
          .from("sources")
          .select("id,title")
          .in("id", ids);
        sourceMap = new Map(
          (sourceRows || []).map((s) => [s.id as string, s.title as string]),
        );
      }

      const bySource = new Map<string, number>();
      for (const c of chunkRows) {
        const sid = c.source_id as string;
        bySource.set(sid, (bySource.get(sid) || 0) + 1);
      }
      const chunkUnits: ChunkWithEmbedding[] = chunkRows.map((c) => {
        const sid = c.source_id as string;
        const multi = (bySource.get(sid) || 0) > 1;
        const idx = c.chunk_index as number;
        const baseTitle = sourceMap.get(sid) || "Source";
        return {
          chunkId: c.id as string,
          documentId: multi ? `${sid}#c${idx}` : sid,
          title: multi ? `${baseTitle} · #${idx + 1}` : baseTitle,
          text: c.text as string,
          chunkIndex: idx,
          embedding: hasEmbeddingColumns
            ? vectorOrNull(c.embedding_json)
            : null,
          embeddingModel: hasEmbeddingColumns
            ? (c.embedding_model ?? null)
            : null,
        };
      });
      if (usedChunkSearchPrefilter && options.searchQuery?.trim()) {
        // Mixed notebooks may contain indexed chunks and raw sources. Apply
        // the same indexed FTS prefilter to raw sources before appending them.
        let rawCandidateQuery = sb
          .from("sources")
          .select("id,title,text,mime")
          .eq("notebook_id", notebookId)
          .textSearch("search_vector", options.searchQuery.trim(), {
            type: "websearch",
            config: "simple",
          })
          .limit(Math.max(1, Math.min(options.searchCandidateLimit || 320, 1000)));
        if (sourceIds?.length) rawCandidateQuery = rawCandidateQuery.in("id", sourceIds);
        const rawCandidate = await rawCandidateQuery;
        const indexedSourceIds = new Set(chunkRows.map((c) => c.source_id as string));
        const rawCandidates = (rawCandidate.data || []).filter(
          (s) => !indexedSourceIds.has(s.id as string),
        );
        if (!rawCandidate.error && rawCandidates.length) {
          return chunkUnits.concat(
            expandRawSourcesToUnits(
              rawCandidates.map((s) => ({
                id: s.id as string,
                title: (s.title as string) || "Source",
                text: (s.text as string) || "",
                mime: (s.mime as string | null) ?? null,
              })),
            ),
          );
        }
      } else {
        // Full chunk reads can safely discover which sources still have no
        // index using IDs only, then fetch text for that small missing set.
        const sourceIdResult = sourceIdResultPromise
          ? await sourceIdResultPromise
          : null;
        if (sourceIdResult && !sourceIdResult.error) {
          const indexed = new Set(chunkRows.map((c) => c.source_id as string));
          const missingIds = (sourceIdResult.data || [])
            .map((s) => s.id as string)
            .filter((sid) => !indexed.has(sid));
          if (missingIds.length) {
            const rawMissing = await sb
              .from("sources")
              .select("id,title,text,mime")
              .in("id", missingIds);
            if (!rawMissing.error && rawMissing.data?.length) {
              return chunkUnits.concat(
                expandRawSourcesToUnits(
                  rawMissing.data.map((s) => ({
                    id: s.id as string,
                    title: (s.title as string) || "Source",
                    text: (s.text as string) || "",
                    mime: (s.mime as string | null) ?? null,
                  })),
                ),
              );
            }
          }
        }
      }
      return chunkUnits;
    }

    // RAW corpus: sources only — expand multi-record CSV / long prose at query time
    let srcQuery = sb
      .from("sources")
      .select("id,title,text,mime")
      .eq("notebook_id", notebookId);
    if (sourceIds?.length) srcQuery = srcQuery.in("id", sourceIds);
    let rawSourceResult;
    const canUseRawSearchPrefilter =
      Boolean(options.searchQuery?.trim()) &&
      (options.searchCandidateLimit || 0) > 0;
    if (canUseRawSearchPrefilter) {
      const candidateLimit = Math.max(1, Math.min(options.searchCandidateLimit || 320, 1000));
      let candidateQuery = sb
        .from("sources")
        .select("id,title,text,mime")
        .eq("notebook_id", notebookId)
        .textSearch("search_vector", options.searchQuery!.trim(), {
          type: "websearch",
          config: "simple",
        })
        .limit(candidateLimit);
      if (sourceIds?.length) candidateQuery = candidateQuery.in("id", sourceIds);
      const candidateResult = await candidateQuery;
      if (!candidateResult.error && (candidateResult.data?.length || 0) > 0) {
        rawSourceResult = candidateResult;
      }
    }
    // Missing migration, invalid FTS syntax, or zero matches all preserve the
    // previous full-source path rather than returning an incomplete corpus.
    if (!rawSourceResult) rawSourceResult = await srcQuery;
    const { data: rawSources, error: sErr } = rawSourceResult;
    if (sErr) throw new Error(`Load sources failed: ${sbError(sErr)}`);
    return expandRawSourcesToUnits(
      (rawSources || []).map((s) => ({
        id: s.id as string,
        title: (s.title as string) || "Source",
        text: (s.text as string) || "",
        mime: (s.mime as string | null) ?? null,
      })),
    );
  }

  const db = getDb();
  const rowFilter = sourceIds?.length
    ? and(eq(chunks.notebookId, notebookId), inArray(chunks.sourceId, sourceIds))
    : eq(chunks.notebookId, notebookId);
  const rows = options.includeEmbeddings === false
    ? await db
        .select({
          id: chunks.id,
          sourceId: chunks.sourceId,
          chunkIndex: chunks.chunkIndex,
          text: chunks.text,
        })
        .from(chunks)
        .where(rowFilter)
    : await db
        .select({
          id: chunks.id,
          sourceId: chunks.sourceId,
          chunkIndex: chunks.chunkIndex,
          text: chunks.text,
          embeddingJson: chunks.embeddingJson,
          embeddingModel: chunks.embeddingModel,
        })
        .from(chunks)
        .where(rowFilter);

  if (rows.length > 0) {
    const sourceIdsNeeded = [...new Set(rows.map((r) => r.sourceId))];
    const sourceRows =
      sourceIdsNeeded.length === 0
        ? []
        : await db
            .select({ id: sources.id, title: sources.title })
            .from(sources)
            .where(inArray(sources.id, sourceIdsNeeded));
    const sourceMap = new Map(sourceRows.map((s) => [s.id, s] as const));

    const bySource = new Map<string, number>();
    for (const c of rows) {
      bySource.set(c.sourceId, (bySource.get(c.sourceId) || 0) + 1);
    }
    return rows.map((c) => {
      const multi = (bySource.get(c.sourceId) || 0) > 1;
      const baseTitle = sourceMap.get(c.sourceId)?.title || "Source";
      return {
        chunkId: c.id,
        documentId: multi ? `${c.sourceId}#c${c.chunkIndex}` : c.sourceId,
        title: multi ? `${baseTitle} · #${c.chunkIndex + 1}` : baseTitle,
        text: c.text,
        chunkIndex: c.chunkIndex,
        embedding: includeEmbeddings
          ? vectorOrNull((c as { embeddingJson?: unknown }).embeddingJson)
          : null,
        embeddingModel: includeEmbeddings
          ? ((c as { embeddingModel?: string | null }).embeddingModel ?? null)
          : null,
      };
    });
  }

  // RAW: expand multi-record / long sources at query time
  let sourceRows = await db
    .select({
      id: sources.id,
      title: sources.title,
      text: sources.text,
      mime: sources.mime,
    })
    .from(sources)
    .where(eq(sources.notebookId, notebookId));
  if (sourceIds?.length) {
    const set = new Set(sourceIds);
    sourceRows = sourceRows.filter((s) => set.has(s.id));
  }
  return expandRawSourcesToUnits(
    sourceRows.map((s) => ({
      id: s.id,
      title: s.title,
      text: s.text,
      mime: s.mime,
    })),
  );
}
