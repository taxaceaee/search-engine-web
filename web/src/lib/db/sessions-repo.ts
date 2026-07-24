import { asc, desc, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { SessionEntity } from "@/lib/context/types";
import type { Metrics, RankedChunk, Timing } from "@/lib/ir/types";
import { assertDurableDb, enrichDbError, getDb, hasDb } from "./client";
import { preferSqlChatHistory } from "./chat-history-schema";
import { searchMessages, searchSessions } from "./schema";
import { getSupabaseAdmin, sbError, toIso } from "./supabase";
import {
  memMessages,
  memSessions,
  type MemSearchMessage,
  type MemSearchSession,
} from "./memory";

export type SearchSessionDto = {
  id: string;
  userId: string | null;
  title: string;
  summary: string | null;
  entities: SessionEntity[];
  createdAt: string;
  updatedAt: string;
};

/**
 * When search_sessions.user_id column is known missing, list/create fall back to
 * SQL (if available) or legacy unscoped rows only as last resort.
 */
let searchSessionsUserIdColumn: boolean | null = null;

export function setSearchSessionsUserIdColumnForTests(v: boolean | null) {
  searchSessionsUserIdColumn = v;
}

function ownsSession(
  sessionUserId: string | null | undefined,
  userId: string | null | undefined,
): boolean {
  if (!userId) return true; // no filter when caller omits owner
  // Null owner rows are never shared once the column exists (or is unknown).
  // Only pure pre-migration mode (column confirmed missing) treats null as public.
  if (sessionUserId == null) {
    return searchSessionsUserIdColumn === false;
  }
  return sessionUserId === userId;
}

function markUserIdColumnMissingFromError(errorText: string): boolean {
  if (
    /user_id/i.test(errorText) &&
    /42703|PGRST204|does not exist|schema cache|Could not find/i.test(errorText)
  ) {
    searchSessionsUserIdColumn = false;
    return true;
  }
  return false;
}

function markUserIdColumnPresent() {
  searchSessionsUserIdColumn = true;
}

export type SearchMessageDto = {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  expandedQuery: string | null;
  results: RankedChunk[] | null;
  timing: Timing | null;
  metrics: Metrics | null;
  status: string;
  createdAt: string;
};

export type SessionListItem = {
  id: string;
  title: string;
  updatedAt: string;
  createdAt: string;
  preview?: string | null;
};

function titleFromQuery(query: string): string {
  const t = query.replace(/\s+/g, " ").trim();
  if (t.length <= 48) return t || "New chat";
  return `${t.slice(0, 47)}…`;
}

function parseEntities(raw: unknown): SessionEntity[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is SessionEntity =>
      Boolean(e && typeof e === "object" && typeof (e as SessionEntity).name === "string"),
  );
}

function memSessionToDto(s: MemSearchSession): SearchSessionDto {
  return {
    id: s.id,
    userId: s.userId ?? null,
    title: s.title,
    summary: s.summary,
    entities: s.entities,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

function memMessageToDto(m: MemSearchMessage): SearchMessageDto {
  return { ...m };
}

export async function listSessions(
  limit = 40,
  userId?: string | null,
): Promise<SessionListItem[]> {
  assertDurableDb("List sessions");
  if (!hasDb()) {
    return Array.from(memSessions.values())
      .filter((s) => ownsSession(s.userId, userId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((s) => {
        const msgs = Array.from(memMessages.values())
          .filter((m) => m.sessionId === s.id && m.role === "user")
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return {
          id: s.id,
          title: s.title,
          updatedAt: s.updatedAt,
          createdAt: s.createdAt,
          preview: msgs[0]?.content?.slice(0, 80) || null,
        };
      });
  }

  // Prefer product REST (same store as messages) when Supabase is configured.
  const sb = getSupabaseAdmin();
  if (sb && searchSessionsUserIdColumn !== false) {
    let q = sb
      .from("search_sessions")
      .select("id,title,user_id,created_at,updated_at")
      .order("updated_at", { ascending: false })
      .limit(Math.max(limit * 3, 50));
    // Always scope by owner when we know the column exists or are probing.
    if (userId) {
      q = q.eq("user_id", userId);
    }
    const { data, error } = await q;
    if (error) {
      if (markUserIdColumnMissingFromError(sbError(error))) {
        console.warn(
          "[listSessions] REST missing user_id; falling back to SQL if available",
        );
        // fall through to SQL — do not return unscoped legacy list when SQL can isolate
      } else {
        console.error("[listSessions]", sbError(error));
      }
    } else {
      markUserIdColumnPresent();
      return (data || [])
        .filter((r) => ownsSession((r.user_id as string | null) ?? null, userId))
        .slice(0, limit)
        .map((r) => ({
          id: r.id as string,
          title: r.title as string,
          createdAt: toIso(r.created_at),
          updatedAt: toIso(r.updated_at),
        }));
    }
  }

  if (await preferSqlChatHistory()) {
    try {
      const db = getDb();
      const rows = await db
        .select()
        .from(searchSessions)
        .orderBy(desc(searchSessions.updatedAt))
        .limit(limit);
      searchSessionsUserIdColumn = true;
      return rows
        .filter((r) => ownsSession(r.userId, userId))
        .map((r) => ({
          id: r.id,
          title: r.title,
          createdAt: toIso(r.createdAt),
          updatedAt: toIso(r.updatedAt),
        }));
    } catch (err) {
      console.error("[listSessions]", enrichDbError(err, "List sessions").message);
      return [];
    }
  }
  return [];
}

export async function createSession(
  title?: string,
  userId?: string | null,
): Promise<SearchSessionDto> {
  assertDurableDb("Create session");
  const id = randomUUID();
  const now = new Date().toISOString();
  const owner = userId ?? null;
  const row: SearchSessionDto = {
    id,
    userId: owner,
    title: (title || "New chat").trim() || "New chat",
    summary: null,
    entities: [],
    createdAt: now,
    updatedAt: now,
  };

  if (!hasDb()) {
    memSessions.set(id, {
      id,
      userId: owner,
      title: row.title,
      summary: null,
      entities: [],
      createdAt: now,
      updatedAt: now,
    });
    return row;
  }

  // Prefer REST so sessions + messages share the same Supabase store.
  const sb = getSupabaseAdmin();
  if (sb && searchSessionsUserIdColumn !== false) {
    const base = {
      id,
      title: row.title,
      summary: null,
      entities_json: [],
      created_at: now,
      updated_at: now,
    };
    const { error } = await sb.from("search_sessions").insert({
      ...base,
      user_id: owner,
    });
    if (error) {
      const detail = sbError(error);
      if (markUserIdColumnMissingFromError(detail)) {
        console.warn(
          "[createSession] REST missing user_id; falling back to SQL:",
          detail,
        );
        // fall through to SQL so ownership is durable
      } else {
        const missingTable =
          /search_sessions|PGRST205|schema cache|does not exist/i.test(detail);
        if (!missingTable) {
          throw new Error(`Create session failed: ${detail}`);
        }
        console.warn(
          "[createSession] REST missing table, trying SQL:",
          detail,
        );
      }
    } else {
      markUserIdColumnPresent();
      return row;
    }
  }

  if (await preferSqlChatHistory()) {
    try {
      const db = getDb();
      await db.insert(searchSessions).values({
        id,
        userId: owner,
        title: row.title,
        summary: null,
        entitiesJson: [],
        createdAt: new Date(now),
        updatedAt: new Date(now),
      });
      searchSessionsUserIdColumn = true;
      return row;
    } catch (err) {
      throw enrichDbError(err, "Create session");
    }
  }
  throw new Error(
    "Create session failed: no durable backend (set SUPABASE_* or DATABASE_URL with migrations).",
  );
}

export async function getSession(
  id: string,
  userId?: string | null,
): Promise<SearchSessionDto | null> {
  assertDurableDb("Get session");
  if (!hasDb()) {
    const s = memSessions.get(id);
    if (!s) return null;
    if (!ownsSession(s.userId, userId)) return null;
    return memSessionToDto(s);
  }

  const sb = getSupabaseAdmin();
  if (sb) {
    const { data, error } = await sb
      .from("search_sessions")
      .select("id,user_id,title,summary,entities_json,created_at,updated_at")
      .eq("id", id)
      .maybeSingle();
    if (!error && data) {
      const owner = (data.user_id as string | null | undefined) ?? null;
      if (data.user_id !== undefined) searchSessionsUserIdColumn = true;
      if (!ownsSession(owner, userId)) return null;
      return {
        id: data.id as string,
        userId: owner,
        title: data.title as string,
        summary: (data.summary as string | null) || null,
        entities: parseEntities(data.entities_json),
        createdAt: toIso(data.created_at),
        updatedAt: toIso(data.updated_at),
      };
    }
  }

  if (await preferSqlChatHistory()) {
    try {
      const db = getDb();
      const rows = await db
        .select()
        .from(searchSessions)
        .where(eq(searchSessions.id, id))
        .limit(1);
      const r = rows[0];
      if (!r) return null;
      searchSessionsUserIdColumn = true;
      if (!ownsSession(r.userId, userId)) return null;
      return {
        id: r.id,
        userId: r.userId,
        title: r.title,
        summary: r.summary,
        entities: parseEntities(r.entitiesJson),
        createdAt: toIso(r.createdAt),
        updatedAt: toIso(r.updatedAt),
      };
    } catch {
      return null;
    }
  }

  return null;
}

export async function listMessages(sessionId: string): Promise<SearchMessageDto[]> {
  assertDurableDb("List messages");
  if (!hasDb()) {
    return Array.from(memMessages.values())
      .filter((m) => m.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(memMessageToDto);
  }

  const sb = getSupabaseAdmin();
  if (sb) {
    const { data, error } = await sb
      .from("search_messages")
      .select("id,session_id,role,content,expanded_query,results_json,timing_json,metrics_json,status,created_at")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true });
    if (error) {
      throw new Error(`List messages failed: ${sbError(error)}`);
    }
    return (data || []).map((r) => ({
      id: r.id as string,
      sessionId: r.session_id as string,
      role: r.role as "user" | "assistant",
      content: r.content as string,
      expandedQuery: (r.expanded_query as string | null) || null,
      results: (r.results_json as RankedChunk[] | null) || null,
      timing: (r.timing_json as Timing | null) || null,
      metrics: (r.metrics_json as Metrics | null) || null,
      status: r.status as string,
      createdAt: toIso(r.created_at),
    }));
  }

  try {
    const db = getDb();
    const rows = await db
      .select()
      .from(searchMessages)
      .where(eq(searchMessages.sessionId, sessionId))
      .orderBy(asc(searchMessages.createdAt));
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      role: r.role as "user" | "assistant",
      content: r.content,
      expandedQuery: r.expandedQuery,
      results: (r.resultsJson as RankedChunk[] | null) || null,
      timing: (r.timingJson as Timing | null) || null,
      metrics: (r.metricsJson as Metrics | null) || null,
      status: r.status,
      createdAt: toIso(r.createdAt),
    }));
  } catch (err) {
    throw enrichDbError(err, "List messages");
  }
}

export async function updateSession(
  id: string,
  patch: {
    title?: string;
    summary?: string | null;
    entities?: SessionEntity[];
  },
): Promise<SearchSessionDto | null> {
  assertDurableDb('Update session');
  const existing = await getSession(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const next: SearchSessionDto = {
    ...existing,
    userId: existing.userId,
    title: patch.title?.trim() || existing.title,
    summary:
      patch.summary !== undefined ? patch.summary : existing.summary,
    entities: patch.entities !== undefined ? patch.entities : existing.entities,
    updatedAt: now,
  };

  if (!hasDb()) {
    memSessions.set(id, {
      id,
      userId: existing.userId,
      title: next.title,
      summary: next.summary,
      entities: next.entities,
      createdAt: next.createdAt,
      updatedAt: now,
    });
    return next;
  }

  const sb = getSupabaseAdmin();
  if (sb) {
    const { error } = await sb
      .from("search_sessions")
      .update({
        title: next.title,
        summary: next.summary,
        entities_json: next.entities,
        updated_at: now,
      })
      .eq("id", id);
    if (error) throw new Error(`Update session failed: ${sbError(error)}`);
    return next;
  }

  try {
    const db = getDb();
    await db
      .update(searchSessions)
      .set({
        title: next.title,
        summary: next.summary,
        entitiesJson: next.entities,
        updatedAt: new Date(now),
      })
      .where(eq(searchSessions.id, id));
    return next;
  } catch (err) {
    throw enrichDbError(err, "Update session");
  }
}

export async function deleteSession(id: string): Promise<boolean> {
  assertDurableDb('Delete session');
  if (!hasDb()) {
    const existed = memSessions.has(id);
    memSessions.delete(id);
    for (const [mid, m] of memMessages) {
      if (m.sessionId === id) memMessages.delete(mid);
    }
    return existed;
  }

  const sb = getSupabaseAdmin();
  if (sb) {
    // Messages can be large — delete in parallel with session when no FK block;
    // if FK requires children first, messages then session is still one RTT pair.
    const msgRes = await sb.from("search_messages").delete().eq("session_id", id);
    if (msgRes.error) {
      throw new Error(`Delete messages failed: ${sbError(msgRes.error)}`);
    }
    const { error } = await sb.from("search_sessions").delete().eq("id", id);
    if (error) throw new Error(`Delete session failed: ${sbError(error)}`);
    return true;
  }

  try {
    const db = getDb();
    await db.delete(searchMessages).where(eq(searchMessages.sessionId, id));
    await db.delete(searchSessions).where(eq(searchSessions.id, id));
    return true;
  } catch (err) {
    throw enrichDbError(err, "Delete session");
  }
}

export async function addMessage(params: {
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  expandedQuery?: string | null;
  results?: RankedChunk[] | null;
  timing?: Timing | null;
  metrics?: Metrics | null;
  status?: string;
}): Promise<SearchMessageDto> {
  assertDurableDb('Save message');
  const id = randomUUID();
  const now = new Date().toISOString();
  const row: SearchMessageDto = {
    id,
    sessionId: params.sessionId,
    role: params.role,
    content: params.content,
    expandedQuery: params.expandedQuery ?? null,
    results: params.results ?? null,
    timing: params.timing ?? null,
    metrics: params.metrics ?? null,
    status: params.status || "completed",
    createdAt: now,
  };

  if (!hasDb()) {
    memMessages.set(id, row);
    const session = memSessions.get(params.sessionId);
    if (session) {
      session.updatedAt = now;
      memSessions.set(params.sessionId, session);
    }
    // Cap messages in memory
    if (memMessages.size > 500) {
      const sorted = Array.from(memMessages.values()).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      );
      for (const old of sorted.slice(0, memMessages.size - 500)) {
        memMessages.delete(old.id);
      }
    }
    return row;
  }

  const sb = getSupabaseAdmin();
  if (sb) {
    const { error } = await sb.from("search_messages").insert({
      id,
      session_id: params.sessionId,
      role: params.role,
      content: params.content,
      expanded_query: row.expandedQuery,
      results_json: row.results,
      timing_json: row.timing,
      metrics_json: row.metrics,
      status: row.status,
      created_at: now,
    });
    if (error) {
      throw new Error(`Save message failed: ${sbError(error)}`);
    }
    await sb
      .from("search_sessions")
      .update({ updated_at: now })
      .eq("id", params.sessionId);
    return row;
  }

  try {
    const db = getDb();
    await db.insert(searchMessages).values({
      id,
      sessionId: params.sessionId,
      role: params.role,
      content: params.content,
      expandedQuery: row.expandedQuery,
      resultsJson: row.results,
      timingJson: row.timing,
      metricsJson: row.metrics,
      status: row.status,
      createdAt: new Date(now),
    });
    await db
      .update(searchSessions)
      .set({ updatedAt: new Date(now) })
      .where(eq(searchSessions.id, params.sessionId));
  } catch (err) {
    throw enrichDbError(err, "Save message");
  }

  return row;
}

export async function updateSearchMessageMetrics(
  id: string,
  metrics: Metrics,
): Promise<SearchMessageDto | null> {
  assertDurableDb('Update message metrics');
  const mergeMetrics = (previous: unknown): Metrics => ({
    ...(previous && typeof previous === "object" ? (previous as Metrics) : {}),
    ...metrics,
  });
  
  if (!hasDb()) {
    const existing = memMessages.get(id);
    if (!existing) return null;
    const next = { ...existing, metrics: mergeMetrics(existing.metrics) };
    memMessages.set(id, next);
    return next;
  }

  const sb = getSupabaseAdmin();
  if (sb) {
    const { data, error: getErr } = await sb
      .from("search_messages")
      .select("id,session_id,role,content,expanded_query,results_json,timing_json,metrics_json,status,created_at")
      .eq("id", id)
      .maybeSingle();
    if (getErr || !data) return null;
    
    const mergedMetrics = mergeMetrics(data.metrics_json);
    const { error } = await sb
      .from("search_messages")
      .update({ metrics_json: mergedMetrics })
      .eq("id", id);
    if (error) {
      throw new Error(`Update search message metrics failed: ${sbError(error)}`);
    }
    
    return {
      id: data.id,
      sessionId: data.session_id,
      role: data.role as "user" | "assistant",
      content: data.content,
      expandedQuery: data.expanded_query,
      results: data.results_json as RankedChunk[] | null,
      timing: data.timing_json as Timing | null,
      metrics: mergedMetrics,
      status: data.status,
      createdAt: toIso(data.created_at),
    };
  }

  try {
    const db = getDb();
    const existing = await db
      .select()
      .from(searchMessages)
      .where(eq(searchMessages.id, id))
      .then((rows) => rows[0]);
    if (!existing) return null;

    const mergedMetrics = mergeMetrics(existing.metricsJson);
    await db
      .update(searchMessages)
      .set({ metricsJson: mergedMetrics })
      .where(eq(searchMessages.id, id));

    return {
      id: existing.id,
      sessionId: existing.sessionId,
      role: existing.role as "user" | "assistant",
      content: existing.content,
      expandedQuery: existing.expandedQuery,
      results: existing.resultsJson as RankedChunk[] | null,
      timing: existing.timingJson as Timing | null,
      metrics: mergedMetrics,
      status: existing.status,
      createdAt: existing.createdAt.toISOString(),
    };
  } catch (err) {
    throw enrichDbError(err, "Update search message metrics");
  }
}

export { titleFromQuery };
