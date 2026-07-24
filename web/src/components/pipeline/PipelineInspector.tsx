"use client";

import { useMemo, useState, type ComponentType } from "react";
import {
  Check,
  ChevronRight,
  Cpu,
  Layers,
  Loader2,
  Package,
  Search,
  Sparkles,
  X,
  Database,
} from "lucide-react";
import type { Metrics, RankedChunk, Timing } from "@/lib/ir/types";
import { corpusTimingMs } from "@/lib/ir/timing";
import { cn } from "@/lib/utils";
import { EvidenceList } from "@/components/EvidenceList";

export type PipelineStepStatus = "pending" | "running" | "success" | "failed";

export type PipelineVariant = "notebook" | "web";

type StepId =
  | "corpus"
  | "search"
  | "fetch"
  | "chunk"
  | "retrieve"
  | "embedding"
  | "fusion"
  | "pack"
  | "generate";

type StepDef = {
  id: StepId;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
};

const NOTEBOOK_STEPS: StepDef[] = [
  {
    id: "corpus",
    label: "Sources ready",
    description:
      "Full-document raw sources stored in this notebook (no pre-chunk or embed index at upload)",
    icon: Database,
  },
  {
    id: "retrieve",
    label: "Lexical retrieve",
    description:
      "BM25 ranks retrieval units by term overlap (full source text when corpus is raw)",
    icon: Search,
  },
  {
    id: "embedding",
    label: "Dense embedding",
    description:
      "Query-time dense vectors when hybrid mode is on — not stored at upload",
    icon: Cpu,
  },
  {
    id: "fusion",
    label: "Hybrid fusion",
    description: "Adaptive RRF merges BM25 + dense ranks (not cross-encoder)",
    icon: Layers,
  },
  {
    id: "pack",
    label: "Context pack",
    description: "Diversify top evidence across sources for the LLM",
    icon: Package,
  },
  {
    id: "generate",
    label: "Generate",
    description: "LLM writes a cited answer from packed evidence",
    icon: Sparkles,
  },
];

const WEB_STEPS: StepDef[] = [
  {
    id: "search",
    label: "Web search",
    description: "Provider returns candidate pages",
    icon: Search,
  },
  {
    id: "fetch",
    label: "Fetch content",
    description: "Normalize page text for indexing",
    icon: Database,
  },
  {
    id: "chunk",
    label: "Chunk",
    description: "Split documents into overlapping word windows",
    icon: Layers,
  },
  {
    id: "retrieve",
    label: "Lexical retrieve",
    description: "BM25 ranks chunks by term overlap",
    icon: Search,
  },
  {
    id: "embedding",
    label: "Dense embedding",
    description: "Semantic vectors for hybrid retrieval",
    icon: Cpu,
  },
  {
    id: "fusion",
    label: "Hybrid fusion",
    description: "Adaptive RRF merges BM25 + dense ranks",
    icon: Layers,
  },
  {
    id: "pack",
    label: "Context pack",
    description: "Select diverse top-k for generation",
    icon: Package,
  },
  {
    id: "generate",
    label: "Generate",
    description: "LLM answer with citations",
    icon: Sparkles,
  },
];

function fmtMs(ms?: number | null) {
  if (ms == null || !Number.isFinite(ms)) return null;
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
      return mode || "—";
  }
}

function deriveStepStatus(
  id: StepId,
  opts: {
    runStatus: "idle" | "running" | "completed" | "failed";
    legacySteps: Record<string, PipelineStepStatus>;
    metrics: Metrics | null;
    timing: Timing | null;
    results: RankedChunk[];
    chunkCount?: number;
    sourceCount?: number;
  },
): PipelineStepStatus {
  const {
    runStatus,
    legacySteps,
    metrics,
    timing,
    results,
    chunkCount,
    sourceCount,
  } = opts;

  if (
    runStatus === "idle" &&
    !metrics &&
    !results.length &&
    !(sourceCount != null && sourceCount > 0)
  ) {
    return "pending";
  }

  switch (id) {
    case "corpus": {
      // Raw corpora have sources with zero stored chunks — still "ready".
      if (
        (sourceCount != null && sourceCount > 0) ||
        (chunkCount != null && chunkCount > 0)
      ) {
        return "success";
      }
      if (legacySteps.chunk === "success" || legacySteps.search === "success")
        return "success";
      return runStatus === "running" ? "running" : "pending";
    }
    case "search":
      return legacySteps.search || "pending";
    case "fetch":
      return legacySteps.fetch || "pending";
    case "chunk":
      return legacySteps.chunk || "pending";
    case "retrieve": {
      if (legacySteps.retrieve === "running") return "running";
      if (legacySteps.retrieve === "success" || results.length > 0)
        return "success";
      if (runStatus === "failed" && legacySteps.retrieve === "pending")
        return "failed";
      return legacySteps.retrieve || "pending";
    }
    case "embedding": {
      if (!metrics && runStatus === "running" && legacySteps.retrieve === "running")
        return "running";
      if (!metrics) {
        if (legacySteps.retrieve === "success") return "success";
        return "pending";
      }
      if (metrics.retrievalMode === "bm25") return "success"; // skipped intentionally
      if (metrics.denseUsed) return "success";
      if (metrics.denseSkippedReason) return "success"; // completed with skip reason
      if (runStatus === "running" && legacySteps.retrieve === "running")
        return "running";
      return timing?.embeddingMs != null ? "success" : "pending";
    }
    case "fusion": {
      if (legacySteps.retrieve === "running" && !metrics) return "running";
      if (
        metrics?.retrievalMode === "adaptive_rrf" ||
        metrics?.retrievalMode === "legacy_rrf_ce"
      )
        return "success";
      if (metrics?.retrievalMode === "bm25" || metrics?.retrievalMode === "bm25_fallback")
        return "success";
      if (legacySteps.retrieve === "success") return "success";
      return "pending";
    }
    case "pack": {
      if (legacySteps.retrieve === "success" || results.length > 0)
        return "success";
      if (legacySteps.retrieve === "running") return "running";
      return "pending";
    }
    case "generate": {
      if (legacySteps.generate === "running") return "running";
      if (legacySteps.generate === "failed") return "failed";
      if (legacySteps.generate === "success") return "success";
      if (metrics?.llmUsed) return "success";
      if (metrics?.llmSkippedReason) return "failed";
      return "pending";
    }
    default:
      return "pending";
  }
}

function stepMs(
  id: StepId,
  timing: Timing | null,
): number | null {
  if (!timing) return null;
  switch (id) {
    case "corpus":
      return corpusTimingMs(timing);
    case "search":
      return timing.searchMs ?? null;
    case "fetch":
      return timing.fetchMs ?? null;
    case "chunk":
      return timing.chunkMs ?? null;
    case "retrieve":
      return timing.rankMs ?? timing.retrieveMs ?? null;
    case "embedding":
      return timing.embeddingMs ?? null;
    case "fusion":
    case "pack":
      // Folded into retrieveMs today
      return null;
    case "generate":
      return timing.generateMs ?? null;
    default:
      return null;
  }
}

export function PipelineInspector({
  variant = "notebook",
  runStatus,
  steps: legacySteps,
  timing,
  metrics,
  results,
  logs,
  chunkCount,
  sourceCount,
  activeCitation,
  onHoverCitation,
}: {
  variant?: PipelineVariant;
  runStatus: "idle" | "running" | "completed" | "failed";
  steps: Record<string, PipelineStepStatus>;
  timing: Timing | null;
  metrics: Metrics | null;
  results: RankedChunk[];
  logs?: string[];
  chunkCount?: number;
  sourceCount?: number;
  activeCitation?: number | null;
  onHoverCitation?: (id: number | null) => void;
}) {
  const defs = variant === "notebook" ? NOTEBOOK_STEPS : WEB_STEPS;
  const [selected, setSelected] = useState<StepId | null>(null);

  const derived = useMemo(() => {
    return defs.map((def) => ({
      ...def,
      status: deriveStepStatus(def.id, {
        runStatus,
        legacySteps,
        metrics,
        timing,
        results,
        chunkCount,
        sourceCount,
      }),
      ms: stepMs(def.id, timing),
    }));
  }, [
    defs,
    runStatus,
    legacySteps,
    metrics,
    timing,
    results,
    chunkCount,
    sourceCount,
  ]);

  const activeId =
    selected ||
    derived.find((s) => s.status === "running")?.id ||
    (runStatus === "completed" || runStatus === "failed"
      ? derived.find((s) => s.status === "success" || s.status === "failed")?.id
      : null) ||
    derived[0]?.id;

  const active = derived.find((s) => s.id === activeId) || derived[0];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[var(--border)] px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold tracking-tight text-[var(--fg)]">
            Pipeline
          </h2>
          {runStatus === "running" && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--primary)]">
              <Loader2 className="h-3 w-3 animate-spin" />
              Running
            </span>
          )}
          {(runStatus === "completed" || runStatus === "failed") &&
            timing?.totalMs != null && (
              <span className="font-mono text-[11px] text-[var(--fg-muted)]">
                {fmtMs(timing.totalMs)} total
              </span>
            )}
        </div>
        <MetricsStrip timing={timing} metrics={metrics} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Timeline */}
        <ol className="space-y-0.5 p-2" aria-label="Pipeline timeline">
          {derived.map((step, i) => {
            const Icon = step.icon;
            const isActive = step.id === activeId;
            return (
              <li key={step.id}>
                <button
                  type="button"
                  onClick={() => setSelected(step.id)}
                  className={cn(
                    "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                    isActive
                      ? "bg-[var(--primary-soft)] ring-1 ring-[var(--primary-border)]"
                      : "hover:bg-[var(--surface-hover)]",
                  )}
                >
                  <span className="relative mt-0.5 flex shrink-0 flex-col items-center">
                    <StatusIcon status={step.status} />
                    {i < derived.length - 1 && (
                      <span
                        className="mt-1 h-4 w-px bg-[var(--border-strong)]"
                        aria-hidden
                      />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--fg)]">
                        <Icon className="h-3.5 w-3.5 text-[var(--fg-subtle)]" />
                        {step.label}
                      </span>
                      <span className="flex items-center gap-1 font-mono text-[10px] text-[var(--fg-subtle)]">
                        {step.ms != null && fmtMs(step.ms)}
                        <ChevronRight
                          className={cn(
                            "h-3.5 w-3.5 transition-transform",
                            isActive && "text-[var(--primary)]",
                          )}
                        />
                      </span>
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-[var(--fg-muted)]">
                      {stepShortHint(step.id, metrics, chunkCount, sourceCount)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        {/* Detail panel */}
        {active && (
          <div className="border-t border-[var(--border)] p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--fg-subtle)]">
              Step detail · {active.label}
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-[var(--fg-muted)]">
              {active.description}
            </p>
            <div className="mt-3 space-y-2 text-xs">
              <StepDetail
                id={active.id}
                status={active.status}
                ms={active.ms}
                metrics={metrics}
                timing={timing}
                results={results}
                chunkCount={chunkCount}
                sourceCount={sourceCount}
              />
            </div>

            {(active.id === "retrieve" ||
              active.id === "fusion" ||
              active.id === "pack") &&
              results.length > 0 && (
                <div className="mt-4">
                  <h4 className="mb-2 text-xs font-semibold text-[var(--fg)]">
                    Ranked evidence ({results.length})
                  </h4>
                  <EvidenceList
                    results={results}
                    activeId={activeCitation}
                    onHover={onHoverCitation}
                    compact
                  />
                </div>
              )}
          </div>
        )}

        {logs && logs.length > 0 && (
          <details className="border-t border-[var(--border)] p-3 text-[11px] text-[var(--fg-muted)]">
            <summary className="cursor-pointer font-medium hover:text-[var(--fg)]">
              Raw event log
            </summary>
            <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto font-mono text-[10px] text-[var(--fg-subtle)]">
              {logs.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: PipelineStepStatus }) {
  if (status === "running") {
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full border border-[var(--primary-border)] bg-[var(--primary-soft)]">
        <Loader2 className="h-3 w-3 animate-spin text-[var(--primary)]" />
      </span>
    );
  }
  if (status === "success") {
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full border border-emerald-600/25 bg-emerald-50">
        <Check className="h-3 w-3 text-emerald-700" />
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full border border-rose-500/30 bg-rose-50">
        <X className="h-3 w-3 text-rose-600" />
      </span>
    );
  }
  return (
    <span className="flex h-5 w-5 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-elevated)]">
      <span className="h-1.5 w-1.5 rounded-full bg-[var(--fg-subtle)]" />
    </span>
  );
}

function MetricsStrip({
  timing,
  metrics,
}: {
  timing: Timing | null;
  metrics: Metrics | null;
}) {
  if (!timing && !metrics) {
    return (
      <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--fg-subtle)]">
        Run a query to inspect retrieval, embedding, fusion, relative scores, and
        generation.
      </p>
    );
  }

  const parts: string[] = [];
  if (timing?.totalMs != null) parts.push(`Total ${fmtMs(timing.totalMs)}`);
  if (timing && corpusTimingMs(timing) > 0)
    parts.push(`Sources ${fmtMs(corpusTimingMs(timing))}`);
  if (timing?.queryProcessMs != null)
    parts.push(`Query ${fmtMs(timing.queryProcessMs)}`);
  if (timing?.rankMs != null) parts.push(`Rank ${fmtMs(timing.rankMs)}`);
  else if (timing?.retrieveMs != null)
    parts.push(`Retrieve ${fmtMs(timing.retrieveMs)}`);
  if (timing?.bm25Ms != null) parts.push(`BM25 ${fmtMs(timing.bm25Ms)}`);
  if (timing?.embeddingMs != null)
    parts.push(`Embed ${fmtMs(timing.embeddingMs)}`);
  if (timing?.packMs != null) parts.push(`Pack ${fmtMs(timing.packMs)}`);
  if (timing?.generateMs != null)
    parts.push(`Gen ${fmtMs(timing.generateMs)}`);
  if (timing?.overheadMs != null && timing.overheadMs > 0)
    parts.push(`Other ${fmtMs(timing.overheadMs)}`);
  if (metrics?.retrievalMode)
    parts.push(modeLabel(metrics.retrievalMode));
  {
    const top =
      metrics?.topScoreStrength ?? metrics?.confidenceMax;
    if (top != null) parts.push(`top ${(top * 100).toFixed(0)}%`);
  }
  if (metrics?.scoreMargin != null)
    parts.push(`margin ${(metrics.scoreMargin * 100).toFixed(0)}%`);

  return (
    <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-[var(--fg-muted)]">
      {parts.join(" · ")}
    </p>
  );
}

/**
 * Notebook corpus Storage copy.
 *
 * `retrievalUnitCount` is the query-time unit count (metrics.chunkCount / prop
 * chunkCount from DatasetChatLayout). It is **not** stored DB chunk rows — raw
 * ingest always has zero stored chunks, even after a successful ask that ranks
 * many units.
 */
export function describeNotebookCorpusStorage(opts: {
  sourceCount?: number;
  /** Ephemeral retrieval units for this run — never stored chunk rows. */
  retrievalUnitCount?: number;
}): { storage: string; rows: { k: string; v: string }[] } {
  const { sourceCount, retrievalUnitCount } = opts;
  const rows: { k: string; v: string }[] = [];

  if (sourceCount != null) {
    rows.push({ k: "Stored sources", v: String(sourceCount) });
  }

  // Storage describes durable ingest only — never flip to "legacy chunks" just
  // because query-time units > 0.
  const storage =
    sourceCount != null && sourceCount > 0
      ? "Raw full text only (0 stored chunks, 0 embeddings)"
      : "No sources yet";
  rows.push({ k: "Storage", v: storage });

  if (retrievalUnitCount != null && retrievalUnitCount > 0) {
    rows.push({
      k: "Retrieval units (this run)",
      v: String(retrievalUnitCount),
    });
  }

  return { storage, rows };
}

function stepShortHint(
  id: StepId,
  metrics: Metrics | null,
  chunkCount?: number,
  sourceCount?: number,
) {
  switch (id) {
    case "corpus":
      return (
        [
          sourceCount != null ? `${sourceCount} raw sources` : null,
          chunkCount != null && chunkCount > 0
            ? `${chunkCount} query units`
            : sourceCount != null && sourceCount > 0
              ? "full-text units at query time"
              : null,
        ]
          .filter(Boolean)
          .join(" · ") || "Waiting for uploaded sources"
      );
    case "retrieve":
      return metrics?.retrievalMode
        ? modeLabel(metrics.retrievalMode)
        : "BM25 / hybrid ranking";
    case "embedding":
      if (!metrics) return "Query-time vectors (optional)";
      if (metrics.retrievalMode === "bm25") return "Skipped (BM25-only mode)";
      if (metrics.denseUsed)
        return [metrics.embeddingProvider, metrics.embeddingModel]
          .filter(Boolean)
          .join(" · ") || "Dense used at query time";
      return metrics.denseSkippedReason || "Dense not used";
    case "fusion":
      if (
        metrics?.retrievalMode === "adaptive_rrf" ||
        metrics?.retrievalMode === "legacy_rrf_ce" ||
        metrics?.retrievalMode === "sgaf"
      )
        return metrics.retrievalMode === "adaptive_rrf"
          ? `Adaptive RRF · BM25 weight ${metrics.bm25Weight?.toFixed(3) ?? "dynamic"} · k=60`
          : metrics.retrievalMode === "sgaf"
            ? "SGAF B5+P3 · specialist/generalist fusion"
            : "SciNCL + classic RRF · k=60";
      if (metrics?.retrievalMode === "bm25") return "No fusion (lexical only)";
      return "RRF merge of rank lists";
    case "pack":
      return metrics?.contextCount != null
        ? `${metrics.contextCount} units packed · ${metrics.sourcesUsed ?? "?"} sources`
        : "Diversify evidence for LLM";
    case "generate":
      if (metrics?.llmUsed) return "LLM answered with citations";
      if (metrics?.llmSkippedReason) return metrics.llmSkippedReason;
      return "Cited answer stream";
    default:
      return "";
  }
}

function StepDetail({
  id,
  status,
  ms,
  metrics,
  timing,
  results,
  chunkCount,
  sourceCount,
}: {
  id: StepId;
  status: PipelineStepStatus;
  ms: number | null;
  metrics: Metrics | null;
  timing: Timing | null;
  results: RankedChunk[];
  chunkCount?: number;
  sourceCount?: number;
}) {
  const rows: { k: string; v: string }[] = [];

  rows.push({ k: "Status", v: status });
  if (ms != null) rows.push({ k: "Duration", v: fmtMs(ms) || "—" });

  switch (id) {
    case "corpus": {
      // Prop chunkCount and metrics.chunkCount are query-time units, not stored rows.
      const retrievalUnitCount =
        metrics?.chunkCount ??
        (chunkCount != null && chunkCount > 0 ? chunkCount : undefined);
      rows.push(
        ...describeNotebookCorpusStorage({
          sourceCount,
          retrievalUnitCount,
        }).rows,
      );
      break;
    }
    case "search":
      if (metrics?.resultCount != null)
        rows.push({ k: "Hits", v: String(metrics.resultCount) });
      if (timing?.searchMs != null)
        rows.push({ k: "Search ms", v: String(Math.round(timing.searchMs)) });
      break;
    case "fetch":
      if (metrics?.pageCount != null)
        rows.push({ k: "Pages", v: String(metrics.pageCount) });
      break;
    case "chunk":
      if (metrics?.chunkCount != null)
        rows.push({ k: "Query-time units", v: String(metrics.chunkCount) });
      break;
    case "retrieve":
      rows.push({
        k: "Mode",
        v: modeLabel(metrics?.retrievalMode),
      });
      if (metrics?.contextCount != null)
        rows.push({ k: "Packed results", v: String(metrics.contextCount) });
      if (results.length)
        rows.push({ k: "Shown evidence", v: String(results.length) });
      break;
    case "embedding":
      rows.push({
        k: "Dense used",
        v: metrics?.denseUsed ? "yes (query-time)" : "no",
      });
      if (metrics?.denseSkippedReason)
        rows.push({ k: "Skip reason", v: metrics.denseSkippedReason });
      if (metrics?.embeddingProvider)
        rows.push({ k: "Provider", v: metrics.embeddingProvider });
      if (metrics?.embeddingModel)
        rows.push({ k: "Model", v: metrics.embeddingModel });
      if (timing?.embeddingMs != null)
        rows.push({
          k: "Embed ms (query)",
          v: String(Math.round(timing.embeddingMs)),
        });
      break;
    case "fusion":
      rows.push({
        k: "Method",
        v:
          metrics?.retrievalMode === "adaptive_rrf" ||
          metrics?.retrievalMode === "legacy_rrf_ce"
            ? metrics.retrievalMode === "legacy_rrf_ce"
              ? "SciNCL + classic RRF + optional Cross-Encoder"
              : "Classic RRF (Cormack et al.)"
            : metrics?.retrievalMode === "bm25_fallback"
              ? "BM25 only (dense failed)"
              : "BM25 only",
      });
      if (
          metrics?.retrievalMode === "adaptive_rrf" ||
          metrics?.retrievalMode === "legacy_rrf_ce" ||
          metrics?.retrievalMode === "sgaf"
      ) {
        rows.push({
          k: "List weights",
          v: metrics.retrievalMode === "legacy_rrf_ce"
            ? "1.0 (BM25) + 1.0 (SciNCL)"
            : metrics.retrievalMode === "sgaf"
              ? "B5 mode-switch + P3 smoothing"
              : `${metrics.bm25Weight?.toFixed(3) ?? "dynamic"} (BM25) + 1.0 (dense)`,
        });
        if (metrics.retrievalMode !== "sgaf") rows.push({ k: "RRF k", v: "60" });
      }
      rows.push({
        k: "Note",
        v:
          metrics?.retrievalMode === "legacy_rrf_ce"
            ? "Cross-Encoder reranking is optional and reported in the retrieval status when unavailable."
            : "Not a cross-encoder reranker — ranks are fused by reciprocal rank.",
      });
      break;
    case "pack":
      if (metrics?.contextCount != null)
        rows.push({ k: "Packed units", v: String(metrics.contextCount) });
      if (metrics?.sourcesUsed != null)
        rows.push({ k: "Sources used", v: String(metrics.sourcesUsed) });
      break;
    case "generate":
      rows.push({
        k: "LLM used",
        v: metrics?.llmUsed ? "yes" : "no",
      });
      if (metrics?.llmSkippedReason)
        rows.push({ k: "Skip / error", v: metrics.llmSkippedReason });
      if (timing?.generateMs != null)
        rows.push({
          k: "Generate ms",
          v: String(Math.round(timing.generateMs)),
        });
      break;
  }

  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-panel)] p-2.5">
      {rows.map((row) => (
        <div key={row.k} className="contents">
          <dt className="text-[var(--fg-subtle)]">{row.k}</dt>
          <dd className="font-mono text-[11px] text-[var(--fg)] break-words">
            {row.v}
          </dd>
        </div>
      ))}
    </dl>
  );
}
