import { Check, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Timing } from "@/lib/ir/types";
import { corpusTimingMs } from "@/lib/ir/timing";

const labels: Record<string, string> = {
  expand: "Context",
  corpus: "Sources",
  search: "Search",
  fetch: "Fetch",
  chunk: "Units",
  query: "Query",
  retrieve: "Retrieve",
  embedding: "Embed",
  fusion: "Fusion",
  pack: "Pack",
  generate: "Generate",
};

export function StepRail({
  steps,
  timing,
  className,
}: {
  steps: Record<string, "pending" | "running" | "success" | "failed">;
  timing?: Timing | null;
  className?: string;
}) {
  const keys = Object.keys(labels).filter((key) => key in steps);
  if (!keys.length) return null;

  return (
    <div
      className={cn(
        "chat-step-rail",
        className,
      )}
      role="list"
      aria-label="Pipeline steps"
    >
      {keys.map((key, i) => {
        const label = labels[key] || key;
        const status = steps[key] || "pending";
        const isLast = i === keys.length - 1;
        const duration = stepDuration(key, timing);
        return (
          <div key={key} className="flex min-w-0 items-center" role="listitem">
            <div
              className={cn(
                "chat-step-pill",
                status === "success" && "chat-step-pill--success",
                status === "running" && "chat-step-pill--running",
                status === "failed" && "chat-step-pill--failed",
                status === "pending" && "chat-step-pill--pending",
              )}
            >
              <span className="chat-step-icon" aria-hidden>
                {status === "running" && (
                  <Loader2 className="h-3 w-3 animate-spin" />
                )}
                {status === "success" && <Check className="h-3 w-3" strokeWidth={2.5} />}
                {status === "failed" && <X className="h-3 w-3" strokeWidth={2.5} />}
                {status === "pending" && (
                  <span className="h-1.5 w-1.5 rounded-full bg-current opacity-50" />
                )}
              </span>
              <span className="truncate">{label}</span>
              <span className="chat-step-time" title={`${label} duration`}>
                {formatDuration(duration)}
              </span>
            </div>
            {!isLast && (
              <span
                className={cn(
                  "chat-step-connector",
                  (status === "success" || status === "running") &&
                    "chat-step-connector--active",
                )}
                aria-hidden
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function stepDuration(step: string, timing?: Timing | null) {
  if (!timing) return undefined;
  switch (step) {
    case "corpus":
      return corpusTimingMs(timing);
    case "search":
      return timing.searchMs;
    case "fetch":
      return timing.fetchMs;
    case "chunk":
      return timing.chunkMs;
    case "query":
      return timing.queryProcessMs;
    case "retrieve":
      return timing.rankMs ?? timing.retrieveMs;
    case "embedding":
      return timing.embeddingMs;
    case "fusion":
      return timing.fusionMs;
    case "pack":
      return timing.packMs;
    case "generate":
      return timing.generateMs;
    default:
      return 0;
  }
}

function formatDuration(ms?: number | null) {
  if (ms == null || !Number.isFinite(ms)) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
