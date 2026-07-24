"use client";

import type { Metrics, Timing } from "@/lib/ir/types";
import { corpusTimingMs } from "@/lib/ir/timing";

function fmtMs(ms?: number | null) {
  if (ms == null || !Number.isFinite(ms)) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function modeLabel(mode?: string) {
  switch (mode) {
    case "rrf":
      return "Hybrid RRF";
    case "adaptive_rrf":
      return "Adaptive RRF";
    case "sgaf":
      return "SGAF B5+P3";
    case "legacy_rrf_ce":
      return "SciNCL + RRF + CE";
    case "bm25_fallback":
      return "BM25 fallback";
    case "bm25":
      return "BM25 only";
    default:
      return mode || "0";
  }
}

function pct(n?: number | null) {
  if (n == null || !Number.isFinite(n)) return "0%";
  return `${Math.round(n * 100)}%`;
}

export function RunMetricsStrip({
  timing,
  metrics,
}: {
  timing: Timing | null;
  metrics: Metrics | null;
}) {
  const latency: { label: string; value: string; hint?: string }[] = [
    { label: "Total", value: fmtMs(timing?.totalMs), hint: "End-to-end wall time" },
    { label: "Sources", value: fmtMs(corpusTimingMs(timing)), hint: "Notebook lookup + corpus load + merge" },
    { label: "Query", value: fmtMs(timing?.queryProcessMs) },
    {
      label: "Rank",
      value: fmtMs(timing?.rankMs ?? timing?.retrieveMs),
      hint: "Wall time for retrieval/ranking; BM25, embedding and fusion may overlap",
    },
    { label: "BM25", value: fmtMs(timing?.bm25Ms) },
    {
      label: "Embed",
      value: fmtMs(timing?.embeddingMs),
      hint: "Query-time dense vectors (not stored at upload)",
    },
    { label: "Pack", value: fmtMs(timing?.packMs) },
    { label: "Answer", value: fmtMs(timing?.generateMs) },
  ];
  latency.push({
    label: "TTFT",
    value: fmtMs(timing?.ttftMs),
    hint: "Time to first token",
  });
  latency.push({
    label: "Other",
    value: fmtMs(timing?.overheadMs),
    hint: "Measured wall time not assigned to a named top-level stage",
  });

  const topStrength = pct(
    metrics?.topScoreStrength ?? metrics?.confidenceMax,
  );
  const relMean = pct(
    metrics?.relativeScoreMean ?? metrics?.confidenceMean,
  );
  const margin = pct(metrics?.scoreMargin);

  return (
    <div className="min-w-0 space-y-3">
      {/* Mode + quality — standard IR labels */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--fg-subtle)]">
          Retrieval quality
        </p>
        <p className="mt-0.5 text-[10px] leading-relaxed text-[var(--fg-subtle)]">
          Okapi BM25 + dense cosine with mode-specific rank fusion. Legacy uses
          classic RRF; Adaptive uses a query-dependent BM25 weight. Channels use
          different units — do not compare raw numbers across channels. Relative
          = score/best this query (not P(relevant)).
        </p>
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
          <span className="inline-flex min-h-12 items-center rounded-lg bg-[var(--primary-soft)] px-2.5 py-1 text-xs font-semibold text-[var(--primary)] ring-1 ring-[var(--primary-border)]">
            {modeLabel(metrics?.retrievalMode)}
          </span>
          <QualityPill
            label="Top strength"
            value={topStrength}
            strong
            title="Top hit rank score / dual-list RRF ceiling 2/(k+1). Absolute hybrid quality of #1 — not relative-to-list (which is always 100% for #1). Missing values are shown as 0%."
          />
          <QualityPill
            label="Mean relative"
            value={relMean}
            title="Average of (score_i / best score) across ranked documents. Missing values are shown as 0%."
          />
          <QualityPill
            label="Score margin"
            value={margin}
            title="(top1 − top2) / top1 on rank score. Missing values are shown as 0%."
          />
          <QualityPill
            label="Documents"
            value={String(metrics?.documentsRanked ?? 0)}
          />
          <QualityPill
            label="Units ranked"
            value={String(metrics?.chunkCount ?? 0)}
            title="Ephemeral retrieval units this run — not stored chunk rows"
          />
        </div>
      </div>

      {/* Accuracy evaluation section (LLM-as-a-judge) */}
      {(metrics?.faithfulness != null || metrics?.answerRelevancy != null || metrics?.contextRelevancy != null) && (
        <div>
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--fg-subtle)]">
            Generation Accuracy
          </p>
          <div className="grid grid-cols-3 gap-2">
            <AccuracyCard
              label="Faithfulness"
              value={pct(metrics?.faithfulness)}
              score={metrics?.faithfulness ?? 0}
              reason={metrics?.faithfulnessReason}
            />
            <AccuracyCard
              label="Answer Relevancy"
              value={pct(metrics?.answerRelevancy)}
              score={metrics?.answerRelevancy ?? 0}
              reason={metrics?.answerRelevancyReason}
            />
            <AccuracyCard
              label="Context Relevancy"
              value={pct(metrics?.contextRelevancy)}
              score={metrics?.contextRelevancy ?? 0}
              reason={metrics?.contextRelevancyReason}
            />
          </div>
        </div>
      )}

      {/* Latency grid */}
      <div>
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--fg-subtle)]">
          Latency
        </p>
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
          {latency.map((item) => (
            <div
              key={item.label}
              title={item.hint}
              className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-center"
            >
              <div className="text-[9px] font-semibold uppercase tracking-wide text-[var(--fg-subtle)]">
                {item.label}
              </div>
              <div className="mt-0.5 font-mono text-[12px] font-semibold tabular-nums text-[var(--fg)]">
                {item.value}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AccuracyCard({
  label,
  value,
  score,
  reason,
}: {
  label: string;
  value: string;
  score: number;
  reason?: string;
}) {
  let themeClass = "border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--fg)]";
  let dotClass = "bg-gray-400";
  let scoreColor = "text-[var(--fg)]";
  
  if (score >= 0.85) {
    themeClass = "border-emerald-500/20 bg-emerald-500/5 hover:bg-emerald-500/10 hover:border-emerald-500/40 transition-all";
    dotClass = "bg-emerald-500";
    scoreColor = "text-emerald-500";
  } else if (score >= 0.70) {
    themeClass = "border-amber-500/20 bg-amber-500/5 hover:bg-amber-500/10 hover:border-amber-500/40 transition-all";
    dotClass = "bg-amber-500";
    scoreColor = "text-amber-500";
  } else if (score > 0) {
    themeClass = "border-rose-500/20 bg-rose-500/5 hover:bg-rose-500/10 hover:border-rose-500/40 transition-all";
    dotClass = "bg-rose-500";
    scoreColor = "text-rose-500";
  }

  return (
    <div
      title={reason || `${label}: ${value}`}
      className={`relative rounded-xl border p-2.5 text-center flex flex-col justify-between min-h-[76px] cursor-help ${themeClass}`}
    >
      <div className="flex items-center justify-center gap-1 text-[9px] font-semibold uppercase tracking-wider text-[var(--fg-subtle)]">
        <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
        {label}
      </div>
      <div className={`mt-0.5 font-mono text-[14px] font-bold tabular-nums ${scoreColor}`}>
        {value}
      </div>
      {reason && (
        <div className="mt-1 text-[8.5px] leading-tight text-[var(--fg-subtle)] line-clamp-2 overflow-hidden text-ellipsis">
          {reason}
        </div>
      )}
    </div>
  );
}

function QualityPill({
  label,
  value,
  strong,
  title,
}: {
  label: string;
  value: string;
  strong?: boolean;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={
        strong
          ? "inline-flex min-h-12 min-w-[4.75rem] flex-col items-center justify-center rounded-lg border border-[var(--primary-border)] bg-[var(--primary-soft)] px-2 py-1"
          : "inline-flex min-h-12 min-w-[4.75rem] flex-col items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--bg-panel)] px-2 py-1"
      }
    >
      <span className="text-[9px] font-medium text-[var(--fg-subtle)]">
        {label}
      </span>
      <span
        className={
          strong
            ? "font-mono text-[12px] font-bold tabular-nums text-[var(--primary)]"
            : "font-mono text-[12px] font-semibold tabular-nums text-[var(--fg)]"
        }
      >
        {value}
      </span>
    </span>
  );
}
