/**
 * Latency profile for shipped retrieval entry points (analysis evidence).
 * Drives bm25Retrieve + retrieveEvidence + runNotebookAskPipeline on synthetic
 * full-document units (raw-source shape: no stored embeddings).
 *
 * Loads web/.env.local when present so hybridLiveEmbed can call the real
 * embedding provider (Hugging Face / TEI / OpenAI) configured for the project.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { retrieveEvidence } from "./adaptive-rrf";
import { bm25Retrieve } from "./bm25";
import type { ChunkWithEmbedding } from "./types";
import { runNotebookAskPipeline } from "@/lib/pipeline/notebook-ask";

const SCRATCH =
  process.env.LATENCY_SCRATCH ||
  "/tmp/grok-goal-df62908b38e3/implementer";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Minimal dotenv loader (no dependency) for .env.local KEY=VALUE lines. */
function loadEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(filePath)) return out;
  const text = readFileSync(filePath, "utf8");
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function makeCorpus(
  n: number,
  charsPerDoc: number,
  seed = "scientific abstract about retrieval and BM25 ranking ",
): ChunkWithEmbedding[] {
  const pad = seed.repeat(Math.ceil(charsPerDoc / seed.length)).slice(0, charsPerDoc);
  return Array.from({ length: n }, (_, i) => ({
    chunkId: `raw-doc-${i}`,
    documentId: `doc-${i}`,
    title: `Paper ${i} on information retrieval`,
    text: `${pad} document-id-${i} unique-term-${i % 17} transformers attention hybrid search.`,
    chunkIndex: 0,
    embedding: null,
    embeddingModel: null,
  }));
}

function hasEmbeddingConfig(env: Record<string, string | undefined>) {
  const provider = (env.EMBEDDING_PROVIDER || "tei").toLowerCase();
  if (provider === "huggingface") {
    return Boolean(env.EMBEDDING_API_KEY || env.HF_TOKEN);
  }
  return Boolean(env.EMBEDDING_API_URL);
}

describe("retrieval latency profile (shipped path)", () => {
  const prev: Record<string, string | undefined> = {};
  const keys = [
    "RETRIEVAL_MODE",
    "EMBEDDING_API_URL",
    "EMBEDDING_API_KEY",
    "EMBEDDING_PROVIDER",
    "EMBEDDING_MODEL",
    "HF_TOKEN",
    "LLM_API_KEY",
  ] as const;

  /** Snapshot of embedding-related env after loading .env.local (for hybrid). */
  let fileEnv: Record<string, string> = {};

  beforeEach(() => {
    for (const k of keys) prev[k] = process.env[k];
    fileEnv = loadEnvFile(path.join(WEB_ROOT, ".env.local"));
    // Prefer process.env (CI/shell), fall back to .env.local file
    for (const k of keys) {
      if (!process.env[k] && fileEnv[k]) process.env[k] = fileEnv[k];
    }
    // HF often stores token as HF_TOKEN — map for huggingface provider
    if (
      !process.env.EMBEDDING_API_KEY &&
      (process.env.HF_TOKEN || fileEnv.HF_TOKEN) &&
      (process.env.EMBEDDING_PROVIDER === "huggingface" ||
        fileEnv.EMBEDDING_PROVIDER === "huggingface")
    ) {
      process.env.EMBEDDING_API_KEY =
        process.env.HF_TOKEN || fileEnv.HF_TOKEN;
    }
  });

  afterEach(() => {
    for (const k of keys) setEnv(k, prev[k]);
  });

  it("profiles BM25 and hybrid embed on raw full-doc units", async () => {
    mkdirSync(SCRATCH, { recursive: true });

    const query = "BM25 lexical ranking transformers hybrid retrieval";
    const scales = [
      { n: 50, chars: 800 },
      { n: 200, chars: 1500 },
      { n: 400, chars: 1600 },
    ];

    const bm25Rows: Array<Record<string, number | string>> = [];
    for (const s of scales) {
      const corpus = makeCorpus(s.n, s.chars);
      const t0 = performance.now();
      const hits = bm25Retrieve(query, corpus, 40);
      const ms = Math.round(performance.now() - t0);
      const totalChars = corpus.reduce((a, c) => a + c.text.length, 0);
      bm25Rows.push({
        units: s.n,
        charsPerDoc: s.chars,
        totalChars,
        bm25Ms: ms,
        hits: hits.length,
        topScore: hits[0]?.bm25Score ?? 0,
      });
      expect(hits.length).toBeGreaterThan(0);
    }

    // Snapshot embedding env NOW (after dotenv), before we strip it for BM25-only / no-embed legs
    const embedSnapshot = {
      EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
      EMBEDDING_API_URL: process.env.EMBEDDING_API_URL,
      EMBEDDING_API_KEY: process.env.EMBEDDING_API_KEY,
      EMBEDDING_MODEL: process.env.EMBEDDING_MODEL,
      HF_TOKEN: process.env.HF_TOKEN,
    };
    const canHybrid = hasEmbeddingConfig(embedSnapshot);

    // Force BM25-only ask path
    process.env.RETRIEVAL_MODE = "bm25";
    delete process.env.LLM_API_KEY;
    const corpus400 = makeCorpus(400, 1600);
    const askBm25 = await runNotebookAskPipeline(
      {
        query,
        chunks: corpus400,
        documentTopK: 10,
        retrieveTopK: 40,
        contextTopK: 4,
        generateAnswer: false,
      },
      () => {},
    );

    // Adaptive RRF without embedding provider → bm25_fallback
    process.env.RETRIEVAL_MODE = "adaptive_rrf";
    delete process.env.EMBEDDING_API_URL;
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.HF_TOKEN;
    const rrfNoEmbed = await retrieveEvidence(
      query,
      corpus400,
      40,
      "adaptive_rrf",
    );

    // Hybrid live: restore real embedding config and call shipped retrieveEvidence
    let hybridLive: Record<string, unknown>;
    if (canHybrid) {
      if (embedSnapshot.EMBEDDING_PROVIDER)
        process.env.EMBEDDING_PROVIDER = embedSnapshot.EMBEDDING_PROVIDER;
      if (embedSnapshot.EMBEDDING_API_URL)
        process.env.EMBEDDING_API_URL = embedSnapshot.EMBEDDING_API_URL;
      if (embedSnapshot.EMBEDDING_API_KEY)
        process.env.EMBEDDING_API_KEY = embedSnapshot.EMBEDDING_API_KEY;
      if (embedSnapshot.EMBEDDING_MODEL)
        process.env.EMBEDDING_MODEL = embedSnapshot.EMBEDDING_MODEL;
      if (embedSnapshot.HF_TOKEN) process.env.HF_TOKEN = embedSnapshot.HF_TOKEN;
      process.env.RETRIEVAL_MODE = "adaptive_rrf";

      const hybridCorpus = makeCorpus(80, 1500);
      try {
        const t0 = performance.now();
        const hybrid = await retrieveEvidence(
          query,
          hybridCorpus,
          40,
          "adaptive_rrf",
        );
        const wall = Math.round(performance.now() - t0);
        hybridLive = {
          attempted: true,
          units: hybridCorpus.length,
          totalChars: hybridCorpus.reduce((a, c) => a + c.text.length, 0),
          wallMs: wall,
          mode: hybrid.diagnostics.mode,
          denseUsed: hybrid.diagnostics.denseUsed,
          denseSkippedReason: hybrid.diagnostics.denseSkippedReason ?? null,
          embeddingMs: hybrid.diagnostics.embeddingMs ?? null,
          bm25Ms: hybrid.diagnostics.bm25Ms ?? null,
          denseMs: hybrid.diagnostics.denseMs ?? null,
          fusionMs: hybrid.diagnostics.fusionMs ?? null,
          embeddingProvider: hybrid.diagnostics.embeddingProvider ?? null,
          embeddingModel: hybrid.diagnostics.embeddingModel ?? null,
        };
      } catch (err) {
        hybridLive = {
          attempted: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    } else {
      hybridLive = {
        attempted: false,
        reason: "no embedding env after loading .env.local",
        seenKeys: {
          provider: Boolean(embedSnapshot.EMBEDDING_PROVIDER),
          apiUrl: Boolean(embedSnapshot.EMBEDDING_API_URL),
          apiKey: Boolean(embedSnapshot.EMBEDDING_API_KEY),
          hfToken: Boolean(embedSnapshot.HF_TOKEN),
        },
      };
    }

    const profile = {
      timestamp: new Date().toISOString(),
      notes: [
        "Synthetic raw-source units (embedding=null) mirror production demos",
        "BM25 caches tokenization, document frequency, and term frequencies per immutable corpus",
        "adaptive_rrf embeds missing corpus units only within the configured live budget; larger/raw PDF corpora use immediate BM25 fallback",
        "hybridLiveEmbed uses real EMBEDDING_* from process/.env.local",
      ],
      bm25Scale: bm25Rows,
      askPipelineBm25Only: {
        units: 400,
        charsPerDoc: 1600,
        timing: askBm25.timing,
        metrics: {
          retrievalMode: askBm25.metrics.retrievalMode,
          chunkCount: askBm25.metrics.chunkCount,
          denseUsed: askBm25.metrics.denseUsed,
          llmUsed: askBm25.metrics.llmUsed,
        },
      },
      adaptiveRrfWithoutEmbedding: {
        mode: rrfNoEmbed.diagnostics.mode,
        denseUsed: rrfNoEmbed.diagnostics.denseUsed,
        denseSkippedReason: rrfNoEmbed.diagnostics.denseSkippedReason,
        bm25Ms: rrfNoEmbed.diagnostics.bm25Ms,
      },
      hybridLiveEmbed: hybridLive,
      codeHotspots: {
        maxDenseChunks: 512,
        maxLiveDenseMissing: 8,
        maxLiveDenseChars: 12000,
        hybridEmbedsMissingVectorsWithinBudget: true,
        rawSourcesAlwaysMissingVectors: true,
        bm25FullCorpusScanPerQuery: false,
        bm25PostingsCandidatePruning: true,
        bm25TermFrequencyMapsCached: true,
      },
    };

    writeFileSync(
      path.join(SCRATCH, "latency-profile.json"),
      JSON.stringify(profile, null, 2),
    );

    expect(askBm25.timing.bm25Ms).toBeTypeOf("number");
    expect(askBm25.timing.totalMs).toBeGreaterThanOrEqual(0);
    expect(askBm25.documents.length).toBeGreaterThan(0);
    expect(
      rrfNoEmbed.diagnostics.mode === "bm25_fallback" ||
        rrfNoEmbed.diagnostics.mode === "adaptive_rrf",
    ).toBe(true);

    // Gating: hybrid profile must actually attempt with configured env
    expect(canHybrid).toBe(true);
    expect(hybridLive.attempted).toBe(true);
    if (hybridLive.denseUsed) {
      expect(hybridLive.embeddingMs).toBeTypeOf("number");
      expect((hybridLive.embeddingMs as number) ).toBeGreaterThan(0);
      expect(hybridLive.bm25Ms).toBeTypeOf("number");
      expect(hybridLive.wallMs).toBeTypeOf("number");
    }
  }, 180_000);
});
