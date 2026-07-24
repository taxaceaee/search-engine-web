"use client";

import { ChevronRight, FileText } from "lucide-react";
import type { Metrics, RankedDocument } from "@/lib/ir/types";
import { cn } from "@/lib/utils";

function relativePct(doc: { relativeScore?: number; confidence?: number }) {
  const c = doc.relativeScore ?? doc.confidence ?? 0;
  return Math.round(Math.max(0, Math.min(1, c)) * 100);
}

export function DocumentResultsList({
  documents,
  retrievalMode,
  activeId,
  onSelect,
}: {
  documents: RankedDocument[];
  retrievalMode?: Metrics["retrievalMode"];
  activeId?: string | null;
  onSelect: (doc: RankedDocument) => void;
}) {
  if (!documents.length) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--bg-panel)] px-4 py-6 text-center">
        <p className="text-sm font-medium text-[var(--fg-muted)]">
          No ranked documents yet
        </p>
        <p className="mt-1 text-xs leading-relaxed text-[var(--fg-subtle)]">
          Run a query — top matches appear here with model score and relative strength.
        </p>
      </div>
    );
  }

  const isHybrid =
    retrievalMode !== "bm25" && retrievalMode !== "bm25_fallback";
  const finalLabel = isHybrid ? "RRF" : "BM25";

  return (
    <ol className="space-y-2">
      {documents.map((doc) => {
        const active = activeId === doc.documentId;
        const pct = relativePct(doc);
        return (
          <li key={doc.documentId}>
            <button
              type="button"
              onClick={() => onSelect(doc)}
              className={cn(
                "group flex min-w-0 w-full items-stretch gap-0 overflow-hidden rounded-xl border text-left transition-all",
                active
                  ? "border-[var(--accent-border)] bg-[var(--accent-soft)] shadow-sm ring-1 ring-[var(--accent-border)]"
                  : "border-[var(--border)] bg-[var(--bg-elevated)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]",
              )}
            >
              {/* Rank stripe */}
              <span
                className={cn(
                  "flex w-11 shrink-0 flex-col items-center justify-center border-r border-[var(--border)] font-mono text-sm font-bold",
                  active
                    ? "bg-[var(--accent)] text-white"
                    : "bg-[var(--bg-panel)] text-[var(--fg-muted)]",
                )}
                aria-label={`Rank ${doc.finalRank}`}
              >
                {doc.finalRank}
              </span>

              <span className="min-w-0 flex-1 px-3 py-3">
                <span className="flex items-start gap-2">
                  <FileText
                    className={cn(
                      "mt-0.5 h-4 w-4 shrink-0",
                      active ? "text-[var(--accent)]" : "text-[var(--fg-subtle)]",
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0">
                    <span className="line-clamp-2 text-[13.5px] font-semibold leading-snug text-[var(--fg)]">
                      {doc.title}
                    </span>
                    {doc.snippet && (
                      <span className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-[var(--fg-muted)]">
                        {doc.snippet}
                      </span>
                    )}
                  </span>
                </span>

                {/* Relative score vs best hit this query (standard within-list normalization) */}
                <span className="mt-2.5 block">
                  <span className="mb-1 flex items-center justify-between text-[11px]">
                    <span
                      className="font-medium text-[var(--fg-muted)]"
                      title="score / best score in this ranking. Not a calibrated relevance probability."
                    >
                      Relative score
                    </span>
                    <span className="font-semibold tabular-nums text-[var(--fg)]">
                      {pct}%
                    </span>
                  </span>
                  <span
                    className="block h-2 overflow-hidden rounded-full bg-[var(--bg-panel)] ring-1 ring-[var(--border)]"
                    aria-hidden
                  >
                    <span
                      className={cn(
                        "block h-full rounded-full transition-[width]",
                        pct >= 70
                          ? "bg-emerald-500"
                          : pct >= 40
                            ? "bg-[var(--accent)]"
                            : "bg-amber-500",
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </span>
                </span>

                {/* Score grid — different units on purpose (standard IR channels) */}
                <span className="mt-2.5 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                  <MetricCell
                    label={finalLabel}
                    value={formatMetric(doc.finalScore, isHybrid ? 4 : 2)}
                    emphasis
                    title={
                      isHybrid
                        ? "Reciprocal Rank Fusion score (k=60), typically ~0–0.033. Not comparable to BM25 raw."
                        : "BM25 fallback score. Dense retrieval was not used for this run."
                    }
                  />
                  <MetricCell
                    label="BM25"
                    value={formatMetric(doc.bm25Best, 2)}
                    title="Okapi BM25 raw score (typically 0–15+). Not the same unit as RRF or dense. An em dash means this document had no lexical hit."
                  />
                  <MetricCell
                    label="Dense"
                    value={formatMetric(doc.denseBest, 2)}
                    title="Cosine similarity. Not the same unit as BM25 or RRF. An em dash means dense retrieval was not used or this document had no dense hit."
                  />
                  <MetricCell
                    label="Hits"
                    value={formatMetric(doc.chunkHits, 0)}
                    title="Units of this doc in the fused top-K"
                  />
                </span>
              </span>

              <span className="flex shrink-0 items-center pr-2">
                <ChevronRight
                  className={cn(
                    "h-4 w-4 text-[var(--fg-subtle)] transition-transform group-hover:translate-x-0.5",
                    active && "text-[var(--accent)]",
                  )}
                />
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function formatMetric(value: number | null | undefined, digits: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(digits)
    : "—";
}

function MetricCell({
  label,
  value,
  emphasis,
  title,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "rounded-md border px-1.5 py-1 text-center",
        emphasis
          ? "border-[var(--accent-border)] bg-[var(--accent-soft)]"
          : "border-[var(--border)] bg-[var(--bg-panel)]",
      )}
    >
      <span className="block text-[9px] font-semibold uppercase tracking-wide text-[var(--fg-subtle)]">
        {label}
      </span>
      <span
        className={cn(
          "mt-0.5 block font-mono text-[11px] font-semibold tabular-nums",
          emphasis ? "text-[var(--accent)]" : "text-[var(--fg)]",
        )}
      >
        {value}
      </span>
    </span>
  );
}
