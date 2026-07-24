import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

/** Application users (email/password accounts) */
export const users = pgTable("users", {
  id: varchar("id", { length: 36 }).primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Index status: none | indexing | ready | failed | skipped */
export const notebooks = pgTable("notebooks", {
  id: varchar("id", { length: 36 }).primaryKey(),
  title: text("title").notNull(),
  /** When true, delete is blocked (demo / user-protected corpora). */
  locked: boolean("locked").notNull().default(false),
  indexStatus: text("index_status").notNull().default("none"),
  indexMessage: text("index_message"),
  unitCount: integer("unit_count").notNull().default(0),
  embeddedCount: integer("embedded_count").notNull().default(0),
  indexedAt: timestamp("indexed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const sources = pgTable("sources", {
  id: varchar("id", { length: 36 }).primaryKey(),
  notebookId: varchar("notebook_id", { length: 36 }).notNull(),
  title: text("title").notNull(),
  mime: text("mime"),
  text: text("text").notNull(),
  /** Cached length so list/read APIs never need to transfer full documents. */
  charCount: integer("char_count"),
  blobUrl: text("blob_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const notebookUploads = pgTable("notebook_uploads", {
  id: varchar("id", { length: 36 }).primaryKey(),
  notebookId: varchar("notebook_id", { length: 36 }).notNull(),
  storageBucket: text("storage_bucket").notNull(),
  storagePath: text("storage_path").notNull(),
  originalFilename: text("original_filename").notNull(),
  safeFilename: text("safe_filename").notNull(),
  mime: text("mime"),
  byteSize: integer("byte_size").notNull(),
  checksum: text("checksum"),
  status: text("status").notNull().default("pending"),
  stage: text("stage").notNull().default("created"),
  progress: integer("progress").notNull().default(0),
  sourceId: varchar("source_id", { length: 36 }),
  errorMessage: text("error_message"),
  retryCount: integer("retry_count").notNull().default(0),
  idempotencyKey: text("idempotency_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const chunks = pgTable("chunks", {
  id: varchar("id", { length: 36 }).primaryKey(),
  sourceId: varchar("source_id", { length: 36 }).notNull(),
  notebookId: varchar("notebook_id", { length: 36 }).notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  text: text("text").notNull(),
  tokenEst: integer("token_est"),
  embeddingJson: jsonb("embedding_json"),
  embeddingModel: text("embedding_model"),
});

export const searchRuns = pgTable("search_runs", {
  id: varchar("id", { length: 36 }).primaryKey(),
  query: text("query").notNull(),
  status: varchar("status", { length: 32 }).notNull().default("completed"),
  resultsJson: jsonb("results_json"),
  answer: text("answer"),
  timingJson: jsonb("timing_json"),
  metricsJson: jsonb("metrics_json"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

/** Multi-turn web search conversations (owned by app user) */
export const searchSessions = pgTable("search_sessions", {
  id: varchar("id", { length: 36 }).primaryKey(),
  userId: varchar("user_id", { length: 36 }),
  title: text("title").notNull().default("New chat"),
  summary: text("summary"),
  entitiesJson: jsonb("entities_json"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const searchMessages = pgTable("search_messages", {
  id: varchar("id", { length: 36 }).primaryKey(),
  sessionId: varchar("session_id", { length: 36 }).notNull(),
  role: varchar("role", { length: 16 }).notNull(),
  content: text("content").notNull(),
  expandedQuery: text("expanded_query"),
  resultsJson: jsonb("results_json"),
  timingJson: jsonb("timing_json"),
  metricsJson: jsonb("metrics_json"),
  status: varchar("status", { length: 32 }).notNull().default("completed"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Per-user chat turns inside a dataset notebook */
export const notebookMessages = pgTable("notebook_messages", {
  id: varchar("id", { length: 36 }).primaryKey(),
  notebookId: varchar("notebook_id", { length: 36 }).notNull(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  role: varchar("role", { length: 16 }).notNull(),
  content: text("content").notNull(),
  resultsJson: jsonb("results_json"),
  timingJson: jsonb("timing_json"),
  metricsJson: jsonb("metrics_json"),
  documentsJson: jsonb("documents_json"),
  status: varchar("status", { length: 32 }).notNull().default("completed"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
