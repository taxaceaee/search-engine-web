import { z } from "zod";
import { UPLOAD_DEFAULTS } from "@/lib/upload-config";

/**
 * Supabase docs often show password as [YOUR-PASSWORD].
 * Strip accidental square brackets around the password segment.
 */
export function normalizeDatabaseUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/:\[([^\]]+)\]@/, ":$1@");
}

/** Derive https://PROJECT.supabase.co from connection string when possible */
export function deriveSupabaseUrl(
  databaseUrl?: string | null,
  explicit?: string | null,
): string | undefined {
  if (explicit?.trim()) return explicit.trim().replace(/\/$/, "");
  if (!databaseUrl) return undefined;

  // Direct: db.PROJECT.supabase.co
  const m = databaseUrl.match(/@db\.([a-z0-9]+)\.supabase\.co/i);
  if (m) return `https://${m[1]}.supabase.co`;

  // Pooler user: postgres.PROJECT:pass@aws-0-....pooler.supabase.com
  const userRef = databaseUrl.match(/\/\/(?:postgres\.)([a-z0-9]+):/i);
  if (userRef) return `https://${userRef[1]}.supabase.co`;

  // Host: PROJECT.supabase.co (rare)
  const host = databaseUrl.match(/@([a-z0-9]+)\.supabase\.co[:/]/i);
  if (host && host[1] !== "db") return `https://${host[1]}.supabase.co`;

  return undefined;
}

/** Secret / service-role key under common env names */
export function resolveSupabaseSecretKey(): string | undefined {
  const candidates = [
    process.env.SUPABASE_SECRET_KEY,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.SUPABASE_SERVICE_KEY,
    process.env.SUPABASE_SECRET,
  ];
  for (const c of candidates) {
    const v = c?.trim();
    if (v) return v;
  }
  return undefined;
}

export function resolveSupabaseUrl(databaseUrl?: string | null): string | undefined {
  return deriveSupabaseUrl(
    databaseUrl,
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  );
}

const envSchema = z.object({
  LLM_BASE_URL: z.string().url().default("https://api.groq.com/openai/v1"),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default("llama-3.1-8b-instant"),
  LLM_MODELS: z.string().optional(),
  VILAO_BASE_URL: z.string().url().default("https://api.vilao.ai/v1"),
  VILAO_API_KEY: z.string().optional(),
  VILAO_MODEL: z.string().default("MiniMax-M2.7"),
  RETRIEVAL_MODE: z
    .enum(["bm25", "adaptive_rrf", "sgaf", "legacy_rrf_ce"])
    .default("bm25"),
  EMBEDDING_PROVIDER: z
    .enum(["openai", "huggingface", "tei"])
    .default("tei"),
  EMBEDDING_API_URL: z.string().url().optional(),
  EMBEDDING_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().default("BAAI/bge-base-en-v1.5"),
  LEGACY_DENSE_MODEL: z.string().default("malteos/scincl"),
  LEGACY_RRF_K: z.string().default("60"),
  LEGACY_RERANKER_URL: z.string().url().optional(),
  LEGACY_RERANKER_MODEL: z
    .string()
    .default("cross-encoder/ms-marco-MiniLM-L-6-v2"),
  SPECIALIST_EMBEDDING_MODEL: z.string().optional(),
  SPECIALIST_EMBEDDING_API_URL: z.string().url().optional(),
  SGAF_SHIFT_THRESHOLD: z.string().default("2.0"),
  P3_WINDOW: z.string().default("20"),
  P3_ALPHA: z.string().default("0.10"),
  TAVILY_API_KEY: z.string().optional(),
  BRAVE_API_KEY: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_PUBLIC_KEY: z.string().optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().optional(),
  SUPABASE_SECRET_KEY: z.string().optional(),
  SUPABASE_JWKS_URL: z.string().url().optional(),
  DIRECT_STORAGE_UPLOADS: z
    .enum(["0", "1"])
    .default(UPLOAD_DEFAULTS.directStorageUploads ? "1" : "0"),
  SUPABASE_STORAGE_BUCKET: z.string().default(UPLOAD_DEFAULTS.storageBucket),
  UPLOAD_SIGNED_URL_TTL_SECONDS: z
    .string()
    .default(String(UPLOAD_DEFAULTS.signedUrlTtlSeconds)),
  APP_PASSWORD: z.string().optional(),
});

export type AppConfig = z.infer<typeof envSchema> & {
  hasLlm: boolean;
  hasSearch: boolean;
  hasEmbedding: boolean;
  hasDb: boolean;
  hasSupabaseRest: boolean;
  directStorageUploads: boolean;
  storageBucket: string;
  supabaseUrl?: string;
  onVercel: boolean;
};

function readRawEnv() {
  const DATABASE_URL = normalizeDatabaseUrl(process.env.DATABASE_URL);
  const SUPABASE_URL = resolveSupabaseUrl(DATABASE_URL);
  const SUPABASE_SECRET_KEY = resolveSupabaseSecretKey();
  return {
    LLM_BASE_URL: process.env.LLM_BASE_URL,
    LLM_API_KEY: process.env.LLM_API_KEY,
    LLM_MODEL: process.env.LLM_MODEL,
    LLM_MODELS: process.env.LLM_MODELS,
    VILAO_BASE_URL: process.env.VILAO_BASE_URL,
    VILAO_API_KEY: process.env.VILAO_API_KEY,
    VILAO_MODEL: process.env.VILAO_MODEL,
    RETRIEVAL_MODE: process.env.RETRIEVAL_MODE,
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    EMBEDDING_API_URL: process.env.EMBEDDING_API_URL,
    EMBEDDING_API_KEY: process.env.EMBEDDING_API_KEY,
    EMBEDDING_MODEL: process.env.EMBEDDING_MODEL,
    LEGACY_DENSE_MODEL: process.env.LEGACY_DENSE_MODEL,
    LEGACY_RRF_K: process.env.LEGACY_RRF_K,
    LEGACY_RERANKER_URL: process.env.LEGACY_RERANKER_URL,
    LEGACY_RERANKER_MODEL: process.env.LEGACY_RERANKER_MODEL,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
    BRAVE_API_KEY: process.env.BRAVE_API_KEY,
    SPECIALIST_EMBEDDING_MODEL: process.env.SPECIALIST_EMBEDDING_MODEL,
    SPECIALIST_EMBEDDING_API_URL: process.env.SPECIALIST_EMBEDDING_API_URL,
    SGAF_SHIFT_THRESHOLD: process.env.SGAF_SHIFT_THRESHOLD,
    P3_WINDOW: process.env.P3_WINDOW,
    P3_ALPHA: process.env.P3_ALPHA,
    DATABASE_URL,
    SUPABASE_URL,
    SUPABASE_PUBLIC_KEY:
      process.env.SUPABASE_PUBLIC_KEY ||
      process.env.SUPABASE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
    SUPABASE_SECRET_KEY,
    SUPABASE_JWKS_URL: process.env.SUPABASE_JWKS_URL,
    DIRECT_STORAGE_UPLOADS: process.env.DIRECT_STORAGE_UPLOADS,
    SUPABASE_STORAGE_BUCKET: process.env.SUPABASE_STORAGE_BUCKET,
    UPLOAD_SIGNED_URL_TTL_SECONDS: process.env.UPLOAD_SIGNED_URL_TTL_SECONDS,
    APP_PASSWORD: process.env.APP_PASSWORD,
  };
}

export function getConfig(): AppConfig {
  const raw = readRawEnv();
  const parsed = envSchema.safeParse(raw);

  const data: z.infer<typeof envSchema> = parsed.success
    ? parsed.data
    : {
        LLM_BASE_URL: raw.LLM_BASE_URL || "https://api.groq.com/openai/v1",
        LLM_API_KEY: raw.LLM_API_KEY,
        LLM_MODEL: raw.LLM_MODEL || "llama-3.1-8b-instant",
        LLM_MODELS: raw.LLM_MODELS,
        VILAO_BASE_URL: raw.VILAO_BASE_URL || "https://api.vilao.ai/v1",
        VILAO_API_KEY: raw.VILAO_API_KEY,
        VILAO_MODEL: raw.VILAO_MODEL || "MiniMax-M2.7",
        RETRIEVAL_MODE:
          raw.RETRIEVAL_MODE === "adaptive_rrf" ||
          raw.RETRIEVAL_MODE === "sgaf" ||
          raw.RETRIEVAL_MODE === "legacy_rrf_ce"
            ? (raw.RETRIEVAL_MODE as "adaptive_rrf" | "sgaf" | "legacy_rrf_ce")
            : "bm25",
        EMBEDDING_PROVIDER:
          raw.EMBEDDING_PROVIDER === "openai" ||
          raw.EMBEDDING_PROVIDER === "huggingface" ||
          raw.EMBEDDING_PROVIDER === "tei"
            ? raw.EMBEDDING_PROVIDER
            : "tei",
        EMBEDDING_API_URL: raw.EMBEDDING_API_URL,
        EMBEDDING_API_KEY: raw.EMBEDDING_API_KEY,
        EMBEDDING_MODEL: raw.EMBEDDING_MODEL || "BAAI/bge-base-en-v1.5",
        LEGACY_DENSE_MODEL: raw.LEGACY_DENSE_MODEL || "malteos/scincl",
        LEGACY_RRF_K: raw.LEGACY_RRF_K || "60",
        LEGACY_RERANKER_URL: raw.LEGACY_RERANKER_URL,
        LEGACY_RERANKER_MODEL:
          raw.LEGACY_RERANKER_MODEL || "cross-encoder/ms-marco-MiniLM-L-6-v2",
        TAVILY_API_KEY: raw.TAVILY_API_KEY,
        BRAVE_API_KEY: raw.BRAVE_API_KEY,
        SPECIALIST_EMBEDDING_MODEL: raw.SPECIALIST_EMBEDDING_MODEL,
        SPECIALIST_EMBEDDING_API_URL: raw.SPECIALIST_EMBEDDING_API_URL,
        SGAF_SHIFT_THRESHOLD: raw.SGAF_SHIFT_THRESHOLD || "2.0",
        P3_WINDOW: raw.P3_WINDOW || "20",
        P3_ALPHA: raw.P3_ALPHA || "0.10",
        DATABASE_URL: raw.DATABASE_URL,
        SUPABASE_URL: raw.SUPABASE_URL,
        SUPABASE_PUBLIC_KEY: raw.SUPABASE_PUBLIC_KEY,
        SUPABASE_PUBLISHABLE_KEY: raw.SUPABASE_PUBLISHABLE_KEY,
        SUPABASE_SECRET_KEY: raw.SUPABASE_SECRET_KEY,
        SUPABASE_JWKS_URL: raw.SUPABASE_JWKS_URL,
        DIRECT_STORAGE_UPLOADS: raw.DIRECT_STORAGE_UPLOADS === "0" ? "0" : "1",
        SUPABASE_STORAGE_BUCKET:
          raw.SUPABASE_STORAGE_BUCKET || UPLOAD_DEFAULTS.storageBucket,
        UPLOAD_SIGNED_URL_TTL_SECONDS:
          raw.UPLOAD_SIGNED_URL_TTL_SECONDS ||
          String(UPLOAD_DEFAULTS.signedUrlTtlSeconds),
        APP_PASSWORD: raw.APP_PASSWORD,
      };

  const supabaseUrl =
    data.SUPABASE_URL || resolveSupabaseUrl(data.DATABASE_URL);

  const hasSupabaseRest = Boolean(supabaseUrl && data.SUPABASE_SECRET_KEY);
  const hasSql = Boolean(data.DATABASE_URL);
  const onVercel = process.env.VERCEL === "1" || Boolean(process.env.VERCEL_ENV);

  return {
    ...data,
    supabaseUrl,
    hasLlm: Boolean(data.LLM_API_KEY),
    hasSearch: Boolean(data.TAVILY_API_KEY || data.BRAVE_API_KEY),
    hasEmbedding:
      data.EMBEDDING_PROVIDER === "huggingface"
        ? Boolean(data.EMBEDDING_API_KEY)
        : Boolean(data.EMBEDDING_API_URL),
    hasDb: hasSupabaseRest || hasSql,
    hasSupabaseRest,
    directStorageUploads: data.DIRECT_STORAGE_UPLOADS === "1" && hasSupabaseRest,
    storageBucket: data.SUPABASE_STORAGE_BUCKET,
    onVercel,
  };
}

/** Server-approved generation models. Never expose API keys or provider URLs. */
export function getAvailableLlmModels(cfg: AppConfig = getConfig()): string[] {
  const configured = (cfg.LLM_MODELS || "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  const providerModels = cfg.VILAO_API_KEY ? [cfg.VILAO_MODEL] : [];
  return [...new Set([cfg.LLM_MODEL, ...configured, ...providerModels])];
}

export function resolveLlmModel(
  requested: string | undefined,
  cfg: AppConfig = getConfig(),
): string {
  const models = getAvailableLlmModels(cfg);
  const model = requested?.trim();
  if (!model) return cfg.LLM_MODEL;
  if (!models.includes(model)) {
    throw new Error("Unsupported LLM model. Add it to LLM_MODELS first.");
  }
  return model;
}

export function resolveLlmConfig(
  requested: string | undefined,
  cfg: AppConfig = getConfig(),
): { model: string; baseUrl: string; apiKey?: string } {
  const model = resolveLlmModel(requested, cfg);
  if (model === cfg.VILAO_MODEL) {
    if (!cfg.VILAO_API_KEY) {
      throw new Error("Vilao API key is not configured for this model.");
    }
    return { model, baseUrl: cfg.VILAO_BASE_URL, apiKey: cfg.VILAO_API_KEY };
  }
  return { model, baseUrl: cfg.LLM_BASE_URL, apiKey: cfg.LLM_API_KEY };
}

/** Human-readable fix when DB is misconfigured (especially Vercel). */
export function dbSetupHint(cfg: AppConfig = getConfig()): string {
  if (cfg.hasSupabaseRest) {
    return "Using Supabase REST. If queries fail, run web/drizzle/0000_init.sql in Supabase SQL Editor.";
  }
  if (cfg.DATABASE_URL && cfg.onVercel) {
    return (
      "Vercel is using DATABASE_URL (direct Postgres) which often fails. " +
      "Add SUPABASE_URL + SUPABASE_SECRET_KEY (Dashboard → Settings → API Keys → secret) " +
      "in Vercel Project → Settings → Environment Variables, then Redeploy. " +
      'GET /api/health?token=HEALTH_SECRET should show providers.db: "supabase-rest".'
    );
  }
  if (cfg.DATABASE_URL) {
    return "Using DATABASE_URL SQL. Prefer SUPABASE_URL + SUPABASE_SECRET_KEY for reliability.";
  }
  if (cfg.supabaseUrl && !cfg.SUPABASE_SECRET_KEY) {
    return (
      "SUPABASE_URL is set but SUPABASE_SECRET_KEY is missing. " +
      "Add the secret/service_role key and redeploy."
    );
  }
  return "No DB configured — history/notebooks use in-memory store (lost on restart).";
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/**
 * IR / ingest caps.
 * - maxNotebookChars: sum of all source text in one notebook (raise via MAX_NOTEBOOK_CHARS).
 * - maxUploadBytes: single file size (raise via MAX_UPLOAD_BYTES).
 */
export const IR_DEFAULTS = {
  chunkSizeWords: 280,
  chunkOverlapWords: 40,
  searchLimit: 6,
  retrieveTopK: 12,
  contextTopK: 4,
  /** Enough visible budget for academic comparisons and quantitative detail. */
  maxOutputTokens: envPositiveInt("LLM_MAX_OUTPUT_TOKENS", 1200),
  /** LLM evidence window; kept configurable for provider TPM/context limits. */
  llmMaxCharsPerChunk: envPositiveInt("LLM_MAX_CHARS_PER_CHUNK", 1100),
  llmMaxContextChars: envPositiveInt("LLM_MAX_CONTEXT_CHARS", 6500),
  temperature: 0.1,
  /** Default 15 MB per file (PDF extract can still be large). */
  maxUploadBytes: envPositiveInt("MAX_UPLOAD_BYTES", 15 * 1024 * 1024),
  /**
   * Default 2M chars ≈ long multi-doc corpus.
   * Old hard cap was 200k and blocked real PDFs / multi-source notebooks.
   */
  maxNotebookChars: envPositiveInt("MAX_NOTEBOOK_CHARS", 2_000_000),
  maxChunksPerNotebook: envPositiveInt("MAX_CHUNKS_PER_NOTEBOOK", 2000),
  denseTopK: 40,
  /** Keep enough candidates for semantic recall on medium-sized raw corpora. */
  maxDenseChunks: envPositiveInt("MAX_DENSE_CHUNKS", 512),
  /**
   * Raw sources do not have persisted vectors. Avoid sending an entire raw
   * corpus to the embedding provider during every query; indexed uploads use
   * the normal query-only dense path. Set >0 only when live corpus embedding
   * is explicitly desired for small legacy corpora.
   */
  maxLiveDenseMissing: envPositiveInt("MAX_LIVE_DENSE_MISSING", 8),
  /** Prevent full-PDF text from being sent to the embedding provider live. */
  maxLiveDenseChars: envPositiveInt("MAX_LIVE_DENSE_CHARS", 12_000),
  /** Concurrent embedding batches during upload indexing. Keep low for provider safety. */
  indexEmbeddingConcurrency: envPositiveInt("INDEX_EMBED_CONCURRENCY", 2),
  rrfK: 60,
  adaptiveRrfScale: 1.0,
  adaptiveRrfMinBm25Weight: 0.05,
  adaptiveRrfMaxBm25Weight: 0.9,
  /** SGAF B5+P3 parameters (from frozen SEG paper) */
  sgafShiftThreshold: 2.0,
  p3Window: 20,
  p3Alpha: 0.10,
};
