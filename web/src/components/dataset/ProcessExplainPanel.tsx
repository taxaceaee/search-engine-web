"use client";

import { useMemo, useState } from "react";
import { ChevronRight, FileText } from "lucide-react";
import {
  buildCandidateCompare,
  buildDocumentScoreSeries,
  buildRankTransitions,
  buildStageTimeline,
  buildTimingWaterfall,
  type RankTransitionRow,
  type StageVizRow,
  type WaterfallBar,
} from "@/lib/ir/pipeline-viz";
import type { Metrics, RankedChunk, RankedDocument, Timing } from "@/lib/ir/types";
import { cn } from "@/lib/utils";

function fmtMs(ms: number | null | undefined) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

const BAR_COLORS: Record<WaterfallBar["color"], string> = {
  primary: "bg-[var(--primary)]",
  accent: "bg-[var(--accent)]",
  muted: "bg-slate-400",
  success: "bg-emerald-500",
  warn: "bg-amber-500",
};

export function ProcessExplainPanel({
  timing,
  metrics,
  documents,
  rankedChunks,
  packedChunks,
  onSelectDocument,
}: {
  timing: Timing | null;
  metrics: Metrics | null;
  documents: RankedDocument[];
  rankedChunks: RankedChunk[];
  packedChunks: RankedChunk[];
  /** Open document detail drawer for a source (click rows / cards). */
  onSelectDocument?: (doc: RankedDocument) => void;
}) {
  const stages = useMemo(
    () => buildStageTimeline(timing, metrics),
    [timing, metrics],
  );
  const waterfall = useMemo(
    () => buildTimingWaterfall(timing, metrics),
    [timing, metrics],
  );
  const transitions = useMemo(
    () => buildRankTransitions(rankedChunks, 12),
    [rankedChunks],
  );
  const scoreSeries = useMemo(
    () => buildDocumentScoreSeries(documents, metrics?.retrievalMode),
    [documents, metrics?.retrievalMode],
  );
  const isRrfMode =
    metrics?.retrievalMode === "adaptive_rrf" ||
    metrics?.retrievalMode === "legacy_rrf_ce" ||
    metrics?.retrievalMode === "sgaf";
  const candidates = useMemo(
    () => buildCandidateCompare(rankedChunks, packedChunks, 15),
    [rankedChunks, packedChunks],
  );

  const docsById = useMemo(() => {
    const m = new Map(documents.map((d) => [d.documentId, d] as const));
    return m;
  }, [documents]);

  const [activeStage, setActiveStage] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const selected: StageVizRow | undefined =
    stages.find((s) => s.id === activeStage) ||
    stages.find((s) => s.outcome === "ran") ||
    stages[0];

  const openDoc = (documentId: string) => {
    const doc = docsById.get(documentId);
    if (doc && onSelectDocument) {
      onSelectDocument(doc);
      return;
    }
    // Fallback synthetic doc when only chunks are present
    if (onSelectDocument) {
      const hit = rankedChunks.find((c) => c.documentId === documentId);
      if (!hit) return;
      onSelectDocument({
        documentId,
        title: hit.title,
        finalScore: hit.finalScore ?? hit.bm25Score,
        finalRank: hit.finalRank,
        relativeScore: 0,
        confidence: 0,
        chunkHits: 1,
        topChunkIds: [hit.chunkId],
        snippet: hit.text.slice(0, 160),
      });
    }
  };

  if (!timing && !metrics && !documents.length && !rankedChunks.length) {
    return (
      <p className="text-sm text-[var(--fg-muted)]">
        Run a search to open the full IR process lab: stage explanations, timing
        waterfall, rank transitions (BM25 → dense → final), and score bars.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stage explanations */}
      <div>
        <h3 className="section-title">How the engine ran</h3>
        <p className="mb-3 text-xs leading-relaxed text-[var(--fg-muted)]">
          Click a stage for a teachable explanation. Durations come from the live
          pipeline timing fields (queryProcessMs, bm25Ms, embeddingMs, …).
        </p>
        <ol className="space-y-1.5">
          {stages.map((stage) => {
            const active = selected?.id === stage.id;
            return (
              <li key={stage.id}>
                <button
                  type="button"
                  onClick={() => setActiveStage(stage.id)}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                    active
                      ? "border-[var(--primary-border)] bg-[var(--primary-soft)]"
                      : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--border-strong)]",
                  )}
                >
                  <OutcomePill outcome={stage.outcome} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-semibold text-[var(--fg)]">
                        {stage.label}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-[var(--fg-muted)]">
                        {fmtMs(stage.ms)}
                      </span>
                    </span>
                    {stage.detail && (
                      <span className="mt-0.5 block text-[11px] text-[var(--fg-subtle)]">
                        {stage.detail}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        {selected && (
          <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--bg-panel)] p-3 text-xs leading-relaxed text-[var(--fg-muted)]">
            <p className="font-semibold text-[var(--fg)]">{selected.label}</p>
            <p className="mt-1">{selected.explanation}</p>
            {selected.detail && (
              <p className="mt-2 font-mono text-[10px] text-[var(--fg-subtle)]">
                {selected.detail}
                {selected.ms != null ? ` · ${fmtMs(selected.ms)}` : ""}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Timing waterfall */}
      {waterfall.length > 0 && (
        <div>
          <h3 className="section-title">Timing waterfall</h3>
          <p className="mb-2 text-[11px] text-[var(--fg-muted)]">
            Sequential stage cost as a share of total wall time (
            {fmtMs(timing?.totalMs)}).
          </p>
          <ul className="space-y-2">
            {waterfall.map((bar) => (
              <li
                key={bar.id}
                className="grid grid-cols-[4.5rem_1fr_3rem] items-center gap-2"
              >
                <span className="text-[11px] font-medium text-[var(--fg-muted)]">
                  {bar.label}
                </span>
                <div className="relative h-3 overflow-hidden rounded-full bg-[var(--bg-panel)] ring-1 ring-[var(--border)]">
                  <div
                    className={cn(
                      "absolute top-0 h-full rounded-full opacity-90",
                      BAR_COLORS[bar.color],
                    )}
                    style={{
                      left: `${bar.offsetFraction * 100}%`,
                      width: `${Math.max(bar.fraction * 100, bar.ms > 0 ? 1.5 : 0)}%`,
                    }}
                    title={`${bar.label}: ${fmtMs(bar.ms)}`}
                  />
                </div>
                <span className="text-right font-mono text-[10px] text-[var(--fg-subtle)]">
                  {fmtMs(bar.ms)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Document score bars — clickable */}
      {scoreSeries.length > 0 && (
        <div>
          <h3 className="section-title">
            Top documents — {isRrfMode ? "RRF strength" : "Rank score"} & relative score
          </h3>
          <p className="mb-2 text-[11px] text-[var(--fg-muted)]">
            Click a document to open full source and ranking detail.
          </p>
          <ul className="space-y-2">
            {scoreSeries.map((row) => (
              <li key={row.documentId}>
                <button
                  type="button"
                  onClick={() => openDoc(row.documentId)}
                  className="group w-full space-y-1 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2.5 text-left transition hover:border-[var(--primary-border)] hover:bg-[var(--primary-soft)]"
                >
                  <div className="flex items-start justify-between gap-2 text-[12px]">
                    <span className="min-w-0 flex items-start gap-1.5 font-medium text-[var(--fg)]">
                      <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--primary)]" />
                      <span>
                        <span className="mr-1.5 font-mono text-[10px] text-[var(--fg-subtle)]">
                          #{row.finalRank}
                        </span>
                        <span className="break-words">{row.title}</span>
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] text-[var(--fg-muted)]">
                      {row.finalScore.toFixed(4)} · {((row.relativeScore ?? row.confidence) * 100).toFixed(0)}%
                      <ChevronRight className="h-3.5 w-3.5 opacity-50 group-hover:opacity-100" />
                    </span>
                  </div>
                  <div className="space-y-1">
                    <div className="h-2 overflow-hidden rounded-full bg-[var(--bg-panel)] ring-1 ring-[var(--border)]">
                      <div
                        className="h-full rounded-full bg-[var(--primary)]"
                        style={{ width: `${row.scoreFraction * 100}%` }}
                      />
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-[var(--bg-panel)] ring-1 ring-[var(--border)]">
                      <div
                        className="h-full rounded-full bg-[var(--accent)]"
                        style={{ width: `${row.confFraction * 100}%` }}
                      />
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-1.5 flex gap-3 text-[10px] text-[var(--fg-subtle)]">
            <span className="inline-flex items-center gap-1">
              <span className="h-1.5 w-3 rounded bg-[var(--primary)]" />
              {isRrfMode ? "RRF strength" : "Rank score"}
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-1.5 w-3 rounded bg-[var(--accent)]" /> Relative score
            </span>
          </div>
        </div>
      )}

      {/* Rank transitions — card list with snippet, clickable */}
      {transitions.length > 0 && (
        <div>
          <h3 className="section-title">Rank transitions</h3>
          <p className="mb-2 text-[11px] leading-relaxed text-[var(--fg-muted)]">
            Each card is a retrieval unit. Source title alone is often the same —
            the preview shows <strong className="font-medium text-[var(--fg)]">what
            the unit text is</strong>. Click to open document detail. Tap the
            chevron to expand scores inline.
          </p>
          <ul className="space-y-2">
            {transitions.map((row) => (
              <RankUnitCard
                key={row.chunkId}
                row={row}
                expanded={expandedId === row.chunkId}
                onToggle={() =>
                  setExpandedId((id) =>
                    id === row.chunkId ? null : row.chunkId,
                  )
                }
                onOpen={() => openDoc(row.documentId)}
              />
            ))}
          </ul>
        </div>
      )}

      {/* Candidates vs packed */}
      {candidates.length > 0 && (
        <div>
          <h3 className="section-title">Candidates vs packed context</h3>
          <p className="mb-2 text-[11px] leading-relaxed text-[var(--fg-muted)]">
            Ranking pool vs what the packer sent to the LLM. Click a unit to open
            its source document.
          </p>
          <ul className="max-h-72 space-y-1.5 overflow-y-auto">
            {candidates.map((c) => (
              <li key={c.chunkId}>
                <button
                  type="button"
                  onClick={() => openDoc(c.documentId)}
                  className="group flex w-full items-start gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-2 text-left transition hover:border-[var(--primary-border)] hover:bg-[var(--primary-soft)]"
                >
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--bg-panel)] font-mono text-[10px] font-bold text-[var(--fg-muted)] ring-1 ring-[var(--border)]">
                    {c.finalRank}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-[12px] font-semibold text-[var(--fg)]">
                      <FileText className="h-3 w-3 shrink-0 text-[var(--primary)]" />
                      <span className="truncate">{c.title}</span>
                    </span>
                    {c.snippet && (
                      <span className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-[var(--fg-muted)]">
                        {c.snippet}
                      </span>
                    )}
                  </span>
                  <span
                    className={cn(
                      "mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold",
                      c.inPacked
                        ? "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-600/20"
                        : "bg-[var(--bg-panel)] text-[var(--fg-subtle)] ring-1 ring-[var(--border)]",
                    )}
                  >
                    {c.inPacked ? "in pack" : "ranked only"}
                  </span>
                  <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-[var(--fg-subtle)] opacity-0 transition group-hover:opacity-100" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function RankUnitCard({
  row,
  expanded,
  onToggle,
  onOpen,
}: {
  row: RankTransitionRow;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const delta = row.rankDeltaFromBm25;
  return (
    <li className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] overflow-hidden">
      <div className="flex items-stretch">
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 px-3 py-2.5 text-left transition hover:bg-[var(--primary-soft)]"
        >
          <div className="flex items-start gap-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--primary)] font-mono text-[11px] font-bold text-white">
              {row.finalRank}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="inline-flex max-w-full items-center gap-1 truncate text-[12px] font-semibold text-[var(--fg)]">
                  <FileText className="h-3 w-3 shrink-0 text-[var(--primary)]" />
                  {row.title}
                </span>
                <span className="font-mono text-[10px] text-[var(--fg-subtle)]">
                  BM25 #{row.bm25Rank ?? "—"} → Dense #{row.denseRank ?? "—"} →
                  Final #{row.finalRank}
                </span>
                {delta != null && delta !== 0 && (
                  <span
                    className={cn(
                      "rounded px-1 py-px font-mono text-[10px] font-semibold",
                      delta > 0
                        ? "bg-emerald-50 text-emerald-800"
                        : "bg-rose-50 text-rose-700",
                    )}
                  >
                    {delta > 0 ? `↑${delta}` : `↓${Math.abs(delta)}`}
                  </span>
                )}
              </span>
              {row.snippet ? (
                <span className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-[var(--fg-muted)]">
                  {row.snippet}
                </span>
              ) : (
                <span className="mt-1 text-[11px] italic text-[var(--fg-subtle)]">
                  No text preview
                </span>
              )}
              <span className="mt-1 block text-[10px] font-medium text-[var(--primary)] opacity-80">
                Click to open full document →
              </span>
            </span>
          </div>
        </button>
        <button
          type="button"
          onClick={onToggle}
          className="flex w-9 shrink-0 items-center justify-center border-l border-[var(--border)] text-[var(--fg-subtle)] hover:bg-[var(--surface-hover)]"
          aria-label={expanded ? "Hide scores" : "Show scores"}
          aria-expanded={expanded}
        >
          <ChevronRight
            className={cn(
              "h-4 w-4 transition-transform",
              expanded && "rotate-90",
            )}
          />
        </button>
      </div>
      {expanded && (
        <div className="grid grid-cols-2 gap-1.5 border-t border-[var(--border)] bg-[var(--bg-panel)] px-3 py-2 sm:grid-cols-4">
          <MiniStat label="BM25 rank" value={String(row.bm25Rank ?? "—")} />
          <MiniStat label="Dense rank" value={String(row.denseRank ?? "—")} />
          <MiniStat label="Final rank" value={String(row.finalRank)} />
          <MiniStat
            label="Scores"
            value={`b=${row.bm25Score.toFixed(2)}${
              row.denseScore != null ? ` d=${row.denseScore.toFixed(2)}` : ""
            } f=${row.finalScore.toFixed(3)}`}
          />
        </div>
      )}
    </li>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1">
      <div className="text-[9px] font-semibold uppercase tracking-wide text-[var(--fg-subtle)]">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-[11px] font-semibold text-[var(--fg)]">
        {value}
      </div>
    </div>
  );
}

function OutcomePill({
  outcome,
}: {
  outcome: StageVizRow["outcome"];
}) {
  const label =
    outcome === "ran"
      ? "ran"
      : outcome === "skipped"
        ? "skip"
        : outcome === "failed"
          ? "fail"
          : "…";
  return (
    <span
      className={cn(
        "mt-0.5 inline-flex h-5 min-w-[2.25rem] items-center justify-center rounded px-1 text-[10px] font-semibold uppercase tracking-wide",
        outcome === "ran" && "bg-emerald-50 text-emerald-800",
        outcome === "skipped" && "bg-slate-100 text-slate-600",
        outcome === "failed" && "bg-rose-50 text-rose-700",
        outcome === "idle" && "bg-[var(--bg-panel)] text-[var(--fg-subtle)]",
      )}
    >
      {label}
    </span>
  );
}
