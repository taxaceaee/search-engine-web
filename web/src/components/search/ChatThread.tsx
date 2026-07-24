import { memo, useEffect, useMemo, useRef, type ReactNode } from "react";
import { Bot, User, Loader2 } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/lib/hooks/use-search-chat";
import type { RankedChunk } from "@/lib/ir/types";

function isVietnamese(text: string): boolean {
  const vnRegex = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệđìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ]/i;
  return vnRegex.test(text);
}

function getMetricColorClass(score: number) {
  if (score >= 0.85) {
    return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 ring-emerald-500/20";
  } else if (score >= 0.70) {
    return "bg-amber-500/10 text-amber-600 dark:text-amber-400 ring-amber-500/20";
  }
  return "bg-rose-500/10 text-rose-600 dark:text-rose-400 ring-rose-500/20";
}

function pct(n?: number | null) {
  if (n == null || !Number.isFinite(n)) return "0%";
  return `${Math.round(n * 100)}%`;
}

export const ChatThread = memo(function ChatThread({
  messages,
  activeAssistantId,
  onSelectAssistant,
  empty,
  messageType = "search",
  onUpdateMessage,
}: {
  messages: ChatMessage[];
  activeAssistantId: string | null;
  onSelectAssistant: (id: string) => void;
  empty?: ReactNode;
  messageType?: "search" | "notebook";
  onUpdateMessage?: (msgId: string, update: Partial<ChatMessage>) => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const lastMessage = messages[messages.length - 1];
  const lastMessageContent = lastMessage?.content;
  const lastMessageId = lastMessage?.id;
  const lastMessageStreaming = Boolean(lastMessage?.streaming);

  // Build the preceding-query lookup once per message-array change. The
  // previous implementation did findIndex + slice + reverse for every row,
  // which made a long chat increasingly expensive to render.
  const queryByAssistantId = useMemo(() => {
    const lookup = new Map<string, string>();
    let latestQuery = "";
    for (const message of messages) {
      if (message.role === "user") {
        latestQuery = message.expandedQuery || message.content;
      } else {
        lookup.set(message.id, latestQuery);
      }
    }
    return lookup;
  }, [messages]);

  useEffect(() => {
    // Streaming updates arrive in small batches. Smooth scrolling every
    // batch queues animations and makes long answers visibly stutter.
    endRef.current?.scrollIntoView({
      behavior: lastMessageStreaming ? "auto" : "smooth",
      block: "end",
    });
  }, [lastMessageId, lastMessageContent, lastMessageStreaming]);

  const handleEvaluate = async (
    msgId: string,
    query: string,
    context: RankedChunk[],
    answer: string
  ) => {
    onUpdateMessage?.(msgId, { evaluationStatus: "evaluating", evaluationError: undefined });
    try {
      const res = await fetch("/api/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messageId: msgId,
          messageType,
          query,
          context,
          answer,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Evaluation request failed");
      if (!data.metrics) throw new Error("Evaluator returned no metrics");
      
      onUpdateMessage?.(msgId, {
        evaluationStatus: "completed",
        evaluationMs: data.evaluationMs,
        metrics: data.metrics,
        evaluationError: undefined,
      });
    } catch (err) {
      console.error("Failed to run accuracy evaluation:", err);
      onUpdateMessage?.(msgId, {
        evaluationStatus: "idle",
        evaluationError:
          err instanceof Error ? err.message : "Evaluation failed. Please retry.",
      });
    }
  };

  if (messages.length === 0) {
    return (
      <div className="chat-thread-empty flex min-h-0 flex-1 flex-col items-center justify-center px-4 py-6">
        {empty}
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-5 sm:px-6">
      <div className="mx-auto flex max-w-[var(--chat-max)] flex-col gap-5">
        {messages.map((m) => {
          const isUser = m.role === "user";
          const active = !isUser && m.id === activeAssistantId;

          const queryText = isUser ? "" : queryByAssistantId.get(m.id) || "";
          const isVn = isVietnamese(queryText || m.content || "");

          return (
            <div
              key={m.id}
              className={cn(
                "anim-message flex gap-2.5 sm:gap-3",
                isUser ? "justify-end" : "justify-start",
              )}
            >
              {!isUser && (
                <div className="msg-avatar msg-avatar--bot" aria-hidden>
                  <Bot className="h-3.5 w-3.5" />
                </div>
              )}
              <div
                role={isUser ? undefined : "button"}
                tabIndex={isUser ? undefined : 0}
                onClick={() => {
                  if (isUser) return;
                  const sel = window.getSelection()?.toString();
                  if (sel && sel.length > 0) return;
                  onSelectAssistant(m.id);
                }}
                onKeyDown={(e) => {
                  if (isUser) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelectAssistant(m.id);
                  }
                }}
                className={cn(
                  "msg-bubble hover-lift select-text",
                  isUser ? "msg-bubble--user" : "msg-bubble--assistant",
                  active && "msg-bubble--active",
                )}
              >
                {isUser ? (
                  <p className="whitespace-pre-wrap leading-relaxed">
                    {m.content}
                  </p>
                ) : m.content ? (
                  <Markdown content={m.content} />
                ) : (
                  <p className="text-[var(--fg-muted)]">
                    {m.streaming ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="inline-flex gap-1" aria-hidden>
                          <span className="thinking-dot" />
                          <span className="thinking-dot" />
                          <span className="thinking-dot" />
                        </span>
                        Thinking…
                      </span>
                    ) : (
                      "No answer yet."
                    )}
                  </p>
                )}
                {isUser &&
                  m.expandedQuery &&
                  m.expandedQuery !== m.content && (
                    <p className="mt-2 rounded-md bg-white/50 px-2 py-1 text-[11px] text-[var(--fg-subtle)]">
                      Searched: {m.expandedQuery}
                    </p>
                  )}

                {/* Accuracy interactive evaluation trigger */}
                {!isUser && m.content && !m.streaming && m.results && m.results.length > 0 && (
                  <>
                    {m.evaluationError && (
                      <div
                        className="mt-3 rounded-md border border-rose-500/20 bg-rose-500/5 px-2.5 py-2 text-[11px] text-rose-700 dark:text-rose-300"
                        role="alert"
                      >
                        {m.evaluationError}
                      </div>
                    )}
                    {(m.evaluationStatus === undefined || m.evaluationStatus === "idle") && (
                      <div className="mt-3 border-t border-[var(--border)] pt-2.5 space-y-1.5 anim-enter">
                        <p className="text-[11px] font-medium text-[var(--fg-subtle)]">
                          {isVn
                            ? "Bạn có muốn đánh giá tính chính xác của câu trả lời này không?"
                            : "Do you want to evaluate the accuracy of this answer?"}
                        </p>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleEvaluate(m.id, queryText, m.results || [], m.content);
                            }}
                            className="rounded-md bg-[var(--primary)] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[var(--primary-hover)] transition-all cursor-pointer"
                          >
                            {isVn ? "Có" : "Yes"}
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onUpdateMessage?.(m.id, { evaluationStatus: "declined" });
                            }}
                            className="rounded-md border border-[var(--border)] px-2.5 py-1 text-[11px] font-medium text-[var(--fg-subtle)] hover:bg-[var(--bg-hover)] transition-all cursor-pointer"
                          >
                            {isVn ? "Không" : "No"}
                          </button>
                        </div>
                      </div>
                    )}
                    {m.evaluationStatus === "evaluating" && (
                      <div className="mt-3 border-t border-[var(--border)] pt-2.5 flex items-center gap-2 text-[11px] text-[var(--fg-subtle)]">
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--primary)]" />
                        <span>{isVn ? "Đang đánh giá độ chính xác..." : "Evaluating accuracy..."}</span>
                      </div>
                    )}
                    {m.evaluationStatus === "completed" && m.metrics && (
                      <div className="mt-3 border-t border-[var(--border)] pt-2.5 space-y-1.5 text-[11px] anim-enter">
                        <div className="flex flex-wrap gap-2">
                          {m.metrics.evaluationMethod && (
                            <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset bg-[var(--bg-panel)] text-[var(--fg-muted)] ring-[var(--border)]">
                              {m.metrics.evaluationMethod === "llm" ? "LLM evaluated" : "Heuristic fallback"}
                            </span>
                          )}
                          <span className={cn(
                            "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset",
                            getMetricColorClass(m.metrics.faithfulness ?? 0)
                          )}>
                            {isVn ? "Tính trung thực" : "Faithfulness"}: {pct(m.metrics.faithfulness)}
                          </span>
                          <span className={cn(
                            "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset",
                            getMetricColorClass(m.metrics.answerRelevancy ?? 0)
                          )}>
                            {isVn ? "Độ liên quan câu trả lời" : "Answer Relevancy"}: {pct(m.metrics.answerRelevancy)}
                          </span>
                          <span className={cn(
                            "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset",
                            getMetricColorClass(m.metrics.contextRelevancy ?? 0)
                          )}>
                            {isVn ? "Độ liên quan ngữ cảnh" : "Context Relevancy"}: {pct(m.metrics.contextRelevancy)}
                          </span>
                        </div>
                        {m.metrics.faithfulnessReason && (
                          <p className="text-[10px] text-[var(--fg-subtle)] leading-relaxed italic bg-black/5 dark:bg-white/5 rounded p-1.5">
                            {m.metrics.faithfulnessReason}
                          </p>
                        )}
                        {m.metrics.evaluationWarning && (
                          <p className="rounded-md border border-amber-500/20 bg-amber-500/5 px-1.5 py-1 text-[10px] leading-relaxed text-amber-700 dark:text-amber-300">
                            {m.metrics.evaluationWarning}
                          </p>
                        )}
                      </div>
                    )}
                  </>
                )}

                {!isUser && m.timing?.totalMs != null && (
                  <p className="mt-2.5 border-t border-[var(--border)] pt-2 text-[11px] text-[var(--fg-subtle)]">
                    {m.timing.totalMs}ms
                    {m.evaluationMs != null && ` · ${isVn ? "Thời gian đánh giá" : "Evaluation"}: ${m.evaluationMs}ms`}
                    {m.results?.length
                      ? ` · ${m.results.length} sources`
                      : ""}
                    {active ? " · viewing evidence" : ""}
                  </p>
                )}
              </div>
              {isUser && (
                <div className="msg-avatar msg-avatar--user" aria-hidden>
                  <User className="h-3.5 w-3.5" />
                </div>
              )}
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
    </div>
  );
});
