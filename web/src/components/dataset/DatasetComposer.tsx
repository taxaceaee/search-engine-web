"use client";

import { memo, useEffect, useState } from "react";
import {
  CornerDownLeft,
  Loader2,
  Paperclip,
  Search,
  Square,
} from "lucide-react";
import { RetrievalModePicker } from "@/components/RetrievalModePicker";
import { GenerationModelPicker } from "@/components/GenerationModelPicker";
import { handleSubmitOnEnter } from "@/lib/keyboard";
import type { RetrievalModeId } from "@/lib/ir/retrieval-modes";
import { cn } from "@/lib/utils";

export const DatasetComposer = memo(function DatasetComposer({
  disabled,
  running,
  onSend,
  onCancel,
  onUpload,
  uploading,
  placeholder,
  suggestions = [],
  recommendationIds = [],
  retrievalMode,
  onRetrievalModeChange,
  className,
}: {
  disabled?: boolean;
  running?: boolean;
  uploading?: boolean;
  onSend: (query: string, opts: { retrievalMode: RetrievalModeId; llmModel?: string }) => void;
  onCancel?: () => void;
  onUpload?: (file: File) => void;
  placeholder?: string;
  /** Suggestions are derived from titles already loaded from the database. */
  suggestions?: string[];
  /** Notebook ids whose raw database content should power recommendations. */
  recommendationIds?: string[];
  retrievalMode: RetrievalModeId;
  onRetrievalModeChange: (mode: RetrievalModeId) => void;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [databaseSuggestions, setDatabaseSuggestions] = useState<string[]>([]);
  const [llmModel, setLlmModel] = useState("");

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 3 || recommendationIds.length === 0) {
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void Promise.all(
        recommendationIds.map(async (id) => {
          const response = await fetch(
            `/api/notebooks/${id}/recommendations?q=${encodeURIComponent(trimmed)}`,
            { signal: controller.signal, cache: "no-store" },
          );
          if (!response.ok) return [];
          const data = (await response.json()) as { suggestions?: unknown };
          return Array.isArray(data.suggestions)
            ? data.suggestions.filter((item): item is string => typeof item === "string")
            : [];
        }),
      )
        .then((groups) => setDatabaseSuggestions([...new Set(groups.flat())].slice(0, 5)))
        .catch(() => {
          if (!controller.signal.aborted) setDatabaseSuggestions([]);
        });
    }, 400);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, recommendationIds]);

  const submit = () => {
    const q = query.trim();
    if (!q || disabled || running) return;
    onSend(q, { retrievalMode, llmModel: llmModel || undefined });
    setQuery("");
  };

  const genericTerms = new Set([
    "a",
    "an",
    "and",
    "find",
    "give",
    "how",
    "in",
    "key",
    "main",
    "of",
    "please",
    "summarize",
    "summary",
    "the",
    "what",
  ]);
  const queryTerms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 2 && !genericTerms.has(term));
  const availableSuggestions = recommendationIds.length
    ? databaseSuggestions
    : suggestions;
  const visibleSuggestions = query.trim().length >= 2
    ? availableSuggestions
        .filter((item) => {
          const normalized = item.toLowerCase();
          return queryTerms.length === 0 || queryTerms.some((term) => normalized.includes(term));
        })
        .slice(0, 5)
    : [];

  return (
    <div className={cn("chat-composer-shell dataset-composer-compact", className)}>
      <div className="mx-auto max-w-[var(--chat-max)] space-y-2">
        <div className="flex items-center justify-between gap-2 px-0.5">
          <span className="text-[11px] font-medium text-[var(--fg-subtle)]">
            Retrieval method
          </span>
          <RetrievalModePicker
            value={retrievalMode}
            onChange={onRetrievalModeChange}
            disabled={disabled || running || uploading}
            size="sm"
          />
          <GenerationModelPicker
            value={llmModel}
            onChange={setLlmModel}
            disabled={disabled || running || uploading}
          />
        </div>
        <div className="chat-composer-box !pl-1.5">
          {onUpload && (
            <label
              className={cn(
                "inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[var(--fg-muted)] transition hover:bg-[var(--accent-soft)] hover:text-[var(--accent)]",
                (uploading || running) && "pointer-events-none opacity-50",
              )}
              title="Upload document"
            >
              {uploading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Paperclip className="h-4 w-4" aria-hidden />
              )}
              <span className="sr-only">Upload document</span>
              <input
                type="file"
                accept=".pdf,.txt,.md,.markdown,.csv,.json,text/plain,text/csv,application/pdf,application/csv"
                className="hidden"
                disabled={uploading || running}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onUpload(f);
                  e.target.value = "";
                }}
              />
            </label>
          )}
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) =>
              handleSubmitOnEnter(e, submit, { allowShiftNewline: true })
            }
            rows={2}
            placeholder={
              placeholder ||
              "Ask about your documents… (Enter send · Shift+Enter newline)"
            }
            aria-label="Message"
            className="max-h-32 min-h-[2.25rem] flex-1 resize-none bg-transparent py-1.5 text-[14px] leading-5 text-[var(--fg)] outline-none placeholder:text-[var(--fg-subtle)]"
            disabled={disabled || running}
          />
          <div className="flex shrink-0 items-center gap-1 pb-0.5">
            {running ? (
              <button
                type="button"
                onClick={onCancel}
                className="btn-secondary !min-h-8 !rounded-lg !px-3 !text-xs"
              >
                <Square className="h-3.5 w-3.5" />
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={disabled || !query.trim()}
                className="btn-primary !min-h-8 !rounded-lg !px-3 !text-xs"
              >
                <CornerDownLeft className="h-4 w-4" />
                Send
              </button>
            )}
          </div>
        </div>
        {visibleSuggestions.length > 0 && !running && (
          <div
            className="dataset-composer-suggestions"
            role="listbox"
            aria-label="Database recommendations"
          >
            {visibleSuggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                role="option"
                aria-selected={false}
                className="dataset-composer-suggestion"
                onClick={() => setQuery(suggestion)}
              >
                <span className="dataset-composer-suggestion-icon" aria-hidden>
                  <Search className="h-3.5 w-3.5" />
                </span>
                <span className="truncate">{suggestion}</span>
              </button>
            ))}
          </div>
        )}
        <p className="text-center text-[11px] text-[var(--fg-subtle)]">
          Paperclip stores raw sources · ranking runs at query time
        </p>
      </div>
    </div>
  );
});
