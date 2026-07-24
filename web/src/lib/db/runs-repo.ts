import { desc, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { Metrics, RankedChunk, Timing } from "@/lib/ir/types";
import { assertDurableDb, enrichDbError, getDb, hasDb } from "./client";
import { searchRuns } from "./schema";
import { getSupabaseAdmin, sbError, toIso } from "./supabase";
import { memRuns, type MemSearchRun } from "./memory";

export async function saveSearchRun(params: {
  query: string;
  results: RankedChunk[];
  answer: string;
  timing: Timing;
  metrics: Metrics;
}) {
  assertDurableDb("Save search run");
  const id = randomUUID();
  const now = new Date().toISOString();

  if (!hasDb()) {
    const row: MemSearchRun = {
      id,
      query: params.query,
      status: "completed",
      results: params.results,
      answer: params.answer,
      timing: params.timing,
      metrics: params.metrics,
      createdAt: now,
      completedAt: now,
    };
    memRuns.set(id, row);
    if (memRuns.size > 50) {
      const sorted = Array.from(memRuns.values()).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      );
      for (const old of sorted.slice(0, memRuns.size - 50)) {
        memRuns.delete(old.id);
      }
    }
    return row;
  }

  const sb = getSupabaseAdmin();
  if (sb) {
    const { error } = await sb.from("search_runs").insert({
      id,
      query: params.query,
      status: "completed",
      results_json: params.results,
      answer: params.answer,
      timing_json: params.timing,
      metrics_json: params.metrics,
      created_at: now,
      completed_at: now,
    });
    // History is best-effort
    if (error) {
      console.error("[saveSearchRun]", sbError(error));
    }
    return {
      id,
      query: params.query,
      status: "completed",
      results: params.results,
      answer: params.answer,
      timing: params.timing,
      metrics: params.metrics,
      createdAt: now,
      completedAt: now,
    };
  }

  try {
    const db = getDb();
    await db.insert(searchRuns).values({
      id,
      query: params.query,
      status: "completed",
      resultsJson: params.results,
      answer: params.answer,
      timingJson: params.timing,
      metricsJson: params.metrics,
      createdAt: new Date(now),
      completedAt: new Date(now),
    });
  } catch (err) {
    console.error("[saveSearchRun postgres]", err);
  }

  return {
    id,
    query: params.query,
    status: "completed",
    results: params.results,
    answer: params.answer,
    timing: params.timing,
    metrics: params.metrics,
    createdAt: now,
    completedAt: now,
  };
}

export async function listSearchRuns(limit = 30) {
  assertDurableDb("List search history");
  if (!hasDb()) {
    return Array.from(memRuns.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        query: r.query,
        status: r.status,
        createdAt: r.createdAt,
        completedAt: r.completedAt,
        hasAnswer: Boolean(r.answer),
      }));
  }

  const sb = getSupabaseAdmin();
  if (sb) {
    const { data, error } = await sb
      .from("search_runs")
      .select("id,query,status,created_at,completed_at,answer")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) {
      console.error("[listSearchRuns]", sbError(error));
      return [];
    }
    return (data || []).map((r) => ({
      id: r.id as string,
      query: r.query as string,
      status: r.status as string,
      createdAt: toIso(r.created_at),
      completedAt: r.completed_at ? toIso(r.completed_at) : null,
      hasAnswer: Boolean(r.answer),
    }));
  }

  try {
    const db = getDb();
    const rows = await db
      .select()
      .from(searchRuns)
      .orderBy(desc(searchRuns.createdAt))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      query: r.query,
      status: r.status,
      createdAt: toIso(r.createdAt),
      completedAt: r.completedAt ? toIso(r.completedAt) : null,
      hasAnswer: Boolean(r.answer),
    }));
  } catch (err) {
    console.error("[listSearchRuns]", enrichDbError(err, "List history").message);
    return [];
  }
}

export async function getSearchRun(id: string) {
  assertDurableDb("Get search run");
  if (!hasDb()) {
    return memRuns.get(id) || null;
  }

  const sb = getSupabaseAdmin();
  if (sb) {
    const { data, error } = await sb
      .from("search_runs")
      .select("id,query,status,results_json,answer,timing_json,metrics_json,created_at,completed_at")
      .eq("id", id)
      .maybeSingle();
    if (error || !data) return null;
    return {
      id: data.id as string,
      query: data.query as string,
      status: data.status as string,
      results: (data.results_json as RankedChunk[] | null) || null,
      answer: (data.answer as string | null) || null,
      timing: (data.timing_json as Timing | null) || null,
      metrics: (data.metrics_json as Metrics | null) || null,
      createdAt: toIso(data.created_at),
      completedAt: data.completed_at ? toIso(data.completed_at) : null,
    };
  }

  const db = getDb();
  const rows = await db.select().from(searchRuns).where(eq(searchRuns.id, id)).limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    query: r.query,
    status: r.status,
    results: (r.resultsJson as RankedChunk[] | null) || null,
    answer: r.answer,
    timing: (r.timingJson as Timing | null) || null,
    metrics: (r.metricsJson as Metrics | null) || null,
    createdAt: toIso(r.createdAt),
    completedAt: r.completedAt ? toIso(r.completedAt) : null,
  };
}

export async function deleteSearchRun(id: string) {
  assertDurableDb("Delete search run");
  if (!hasDb()) {
    memRuns.delete(id);
    return;
  }

  const sb = getSupabaseAdmin();
  if (sb) {
    await sb.from("search_runs").delete().eq("id", id);
    return;
  }

  const db = getDb();
  await db.delete(searchRuns).where(eq(searchRuns.id, id));
}
