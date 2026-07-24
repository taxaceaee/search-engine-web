/**
 * Pre-index embeddings: expand units → mock embed store → loadChunks has vectors.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSource,
  createNotebook,
  loadChunks,
} from "@/lib/db/notebooks-repo";
import { memChunks, memNotebooks, memSources } from "@/lib/db/memory";
import { indexNotebookEmbeddings } from "./index-embeddings";
import { retrieveEvidence } from "./adaptive-rrf";

vi.mock("@/lib/ir/embedding", () => ({
  embedTexts: async (texts: string[]) => ({
    embeddings: texts.map((_, i) => {
      // Deterministic pseudo-vectors
      const v = new Array(8).fill(0).map((__, j) => ((i + 1) * (j + 1)) / 10);
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    }),
    provider: "mock",
    model: "mock-embed",
  }),
  cosineSimilarity: (a: number[], b: number[]) => {
    let dot = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i] * b[i];
    return dot;
  },
}));

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const DB_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SERVICE_KEY",
  "SUPABASE_SECRET",
  "NEXT_PUBLIC_SUPABASE_URL",
  "DATABASE_URL",
  "ALLOW_MEMORY_DB",
  "VERCEL",
  "VERCEL_ENV",
  "EMBEDDING_PROVIDER",
  "EMBEDDING_API_KEY",
  "EMBEDDING_MODEL",
] as const;

describe("indexNotebookEmbeddings (pre-store vectors)", () => {
  const prev: Record<string, string | undefined> = {};
  const touched: string[] = [];

  beforeEach(() => {
    for (const k of DB_KEYS) prev[k] = process.env[k];
    for (const k of DB_KEYS) delete process.env[k];
    process.env.ALLOW_MEMORY_DB = "1";
    process.env.EMBEDDING_PROVIDER = "huggingface";
    process.env.EMBEDDING_API_KEY = "test-key";
    process.env.EMBEDDING_MODEL = "mock-embed";
  });

  afterEach(() => {
    for (const id of touched) {
      memNotebooks.delete(id);
      for (const [sid, s] of memSources) {
        if (s.notebookId === id) memSources.delete(sid);
      }
      for (const [cid, c] of memChunks) {
        if (c.notebookId === id) memChunks.delete(cid);
      }
    }
    touched.length = 0;
    for (const k of DB_KEYS) setEnv(k, prev[k]);
    vi.clearAllMocks();
  });

  it("stores embeddings so loadChunks returns vectors (query path skips corpus embed)", async () => {
    const nb = await createNotebook("Index test");
    touched.push(nb.id);
    await addSource({
      notebookId: nb.id,
      title: "a.txt",
      mime: "text/plain",
      text: "Vitamin D helps calcium absorption in the intestine.",
    });
    await addSource({
      notebookId: nb.id,
      title: "b.txt",
      mime: "text/plain",
      text: "Melanoma immunotherapy with PD-1 blockade is effective.",
    });

    const before = await loadChunks(nb.id);
    expect(before.every((u) => !u.embedding)).toBe(true);

    const indexed = await indexNotebookEmbeddings(nb.id);
    expect(indexed.unitCount).toBeGreaterThanOrEqual(2);
    expect(indexed.embeddedCount).toBe(indexed.unitCount);

    const after = await loadChunks(nb.id);
    expect(after.length).toBe(indexed.unitCount);
    expect(after.every((u) => u.embedding && u.embedding.length > 0)).toBe(true);

    const cold = after.map((u) => ({ ...u, embedding: null }));
    const hot = after;

    const coldRes = await retrieveEvidence(
      "vitamin calcium",
      cold,
      5,
      "adaptive_rrf",
    );
    const hotRes = await retrieveEvidence(
      "vitamin calcium",
      hot,
      5,
      "adaptive_rrf",
    );

    expect(coldRes.diagnostics.denseUsed).toBe(true);
    expect(hotRes.diagnostics.denseUsed).toBe(true);
    // Both should return hits; hot uses pre-stored vectors
    expect(hotRes.results.length).toBeGreaterThan(0);
    expect(coldRes.results.length).toBeGreaterThan(0);
  });

  it("stores lexical chunks when dense embedding is unavailable", async () => {
    const nb = await createNotebook("Lexical-only index test");
    touched.push(nb.id);
    await addSource({
      notebookId: nb.id,
      title: "raw.txt",
      mime: "text/plain",
      text: "BM25 lexical retrieval should not re-parse this source per query.",
    });

    delete process.env.EMBEDDING_API_KEY;
    const indexed = await indexNotebookEmbeddings(nb.id);
    expect(indexed.status).toBe("skipped");
    expect(indexed.unitCount).toBeGreaterThan(0);
    expect(indexed.embeddedCount).toBe(0);

    const chunks = await loadChunks(nb.id, undefined, { includeEmbeddings: false });
    expect(chunks.length).toBe(indexed.unitCount);
    expect(chunks.every((chunk) => !chunk.embedding)).toBe(true);
  });

  it("indexes a newly uploaded source without dropping older sources", async () => {
    const nb = await createNotebook("Incremental index test");
    touched.push(nb.id);
    const first = await addSource({
      notebookId: nb.id,
      title: "first.txt",
      mime: "text/plain",
      text: "The first document contains the baseline retrieval claim.",
    });
    const firstIndex = await indexNotebookEmbeddings(nb.id);
    expect(firstIndex.status).toBe("ready");

    const second = await addSource({
      notebookId: nb.id,
      title: "second.txt",
      mime: "text/plain",
      text: "The second document contains the newly uploaded claim.",
    });
    const incremental = await indexNotebookEmbeddings(nb.id, {
      sourceIds: [second.id],
    });
    expect(incremental.status).toBe("ready");

    const chunks = await loadChunks(nb.id);
    expect(new Set(chunks.map((chunk) => chunk.documentId))).toEqual(
      new Set([first.id, second.id]),
    );
  });

  it("serializes concurrent source indexes for one notebook", async () => {
    const nb = await createNotebook("Concurrent index test");
    touched.push(nb.id);
    const one = await addSource({
      notebookId: nb.id,
      title: "one.txt",
      mime: "text/plain",
      text: "Concurrent indexing source one.",
    });
    const two = await addSource({
      notebookId: nb.id,
      title: "two.txt",
      mime: "text/plain",
      text: "Concurrent indexing source two.",
    });

    await Promise.all([
      indexNotebookEmbeddings(nb.id, { sourceIds: [one.id] }),
      indexNotebookEmbeddings(nb.id, { sourceIds: [two.id] }),
    ]);

    const chunks = await loadChunks(nb.id);
    expect(new Set(chunks.map((chunk) => chunk.documentId))).toEqual(
      new Set([one.id, two.id]),
    );
  });
});
