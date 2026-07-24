"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { Metrics, RankedChunk, StreamEvent, Timing } from "@/lib/ir/types";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  expandedQuery?: string | null;
  results?: RankedChunk[] | null;
  timing?: Timing | null;
  metrics?: Metrics | null;
  status?: string;
  createdAt?: string;
  /** True while assistant is streaming */
  streaming?: boolean;
  evaluationStatus?: "idle" | "evaluating" | "completed" | "declined";
  evaluationMs?: number;
  evaluationError?: string;
};

export type SessionSummary = {
  id: string;
  title: string;
  updatedAt: string;
  createdAt: string;
  preview?: string | null;
};

type StepMap = Record<string, "pending" | "running" | "success" | "failed">;

const emptySteps = (): StepMap => ({
  expand: "pending",
  search: "pending",
  fetch: "pending",
  chunk: "pending",
  retrieve: "pending",
  generate: "pending",
});

export function useSearchSessions() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (opts?: { quiet?: boolean }) => {
    // Quiet refreshes (after create/send) must not flip sidebar into a loading
    // spinner — that made the app feel "stuck" for 1s+ on every first message.
    if (!opts?.quiet) setLoading(true);
    try {
      const res = await fetch("/api/search/sessions", { cache: "no-store" });
      const data = await res.json();
      setSessions(Array.isArray(data.items) ? data.items : []);
      setError(data.error || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sessions");
    } finally {
      if (!opts?.quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void refresh();
    }, 0);
    return () => clearTimeout(timer);
  }, [refresh]);

  const create = useCallback(async (title?: string) => {
    const res = await fetch("/api/search/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(title ? { title } : {}),
    });
    const j = (await res.json().catch(() => ({}))) as {
      error?: string;
      id?: string;
      title?: string;
    };
    if (!res.ok || !j.id) {
      throw new Error(
        j.error ||
          `Create session failed (HTTP ${res.status}). If tables are missing, run: cd web && npm run db:init`,
      );
    }
    const now = new Date().toISOString();
    const created = {
      id: j.id,
      title: (j.title || title || "New chat").trim() || "New chat",
    };
    // Optimistic sidebar update — do NOT await listSessions (was 1–2s).
    setSessions((prev) => [
      {
        id: created.id,
        title: created.title,
        createdAt: now,
        updatedAt: now,
      },
      ...prev.filter((s) => s.id !== created.id),
    ]);
    void refresh({ quiet: true });
    return created;
  }, [refresh]);

  const rename = useCallback(
    async (id: string, title: string) => {
      const res = await fetch(`/api/search/sessions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) throw new Error("Rename failed");
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, title } : s)),
      );
      void refresh({ quiet: true });
    },
    [refresh],
  );

  /**
   * Optimistic remove: drop from sidebar immediately, DELETE in background.
   * Rejects only if the server fails — caller may restore UI via refresh.
   */
  const remove = useCallback(async (id: string) => {
    const snapshot = sessions.find((s) => s.id === id);
    // Instant UI
    setSessions((prev) => prev.filter((s) => s.id !== id));

    try {
      const res = await fetch(`/api/search/sessions/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `Delete failed (HTTP ${res.status})`);
      }
      // Quiet background reconcile
      void refresh({ quiet: true });
    } catch (err) {
      // Restore on failure
      if (snapshot) {
        setSessions((prev) => {
          if (prev.some((s) => s.id === id)) return prev;
          return [snapshot, ...prev].sort((a, b) =>
            b.updatedAt.localeCompare(a.updatedAt),
          );
        });
      } else {
        void refresh({ quiet: true });
      }
      throw err;
    }
  }, [sessions, refresh]);

  return { sessions, loading, error, refresh, create, rename, remove };
}

export function useSearchChat(sessionId: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionTitle, setSessionTitle] = useState("New chat");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<"idle" | "running" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<StepMap>(emptySteps());
  const [logs, setLogs] = useState<string[]>([]);
  const [activeAssistantId, setActiveAssistantId] = useState<string | null>(
    null,
  );
  const [lastExpanded, setLastExpanded] = useState<{
    original: string;
    expanded: string;
    usedContext: boolean;
  } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const tokenBuf = useRef("");
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamAssistantId = useRef<string | null>(null);
  /** Tracks last sessionId so we only abort streams when switching chats */
  const prevSessionIdRef = useRef<string | null | undefined>(undefined);
  /** Mirror of status for async load() without stale closures */
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const flushTokens = useCallback(() => {
    if (!tokenBuf.current || !streamAssistantId.current) return;
    const chunk = tokenBuf.current;
    tokenBuf.current = "";
    const aid = streamAssistantId.current;
    setMessages((prev) => {
      const index = prev.findIndex((m) => m.id === aid);
      if (index < 0) return prev;
      const next = prev.slice();
      next[index] = { ...next[index], content: next[index].content + chunk };
      return next;
    });
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimer.current) return;
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      flushTokens();
    }, 40);
  }, [flushTokens]);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/search/sessions/${id}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        // Don't wipe optimistic UI if a send is already streaming.
        if (statusRef.current !== "running") {
          setMessages([]);
          setError("Session not found");
        }
        return;
      }
      const data = await res.json();
      setSessionTitle(data.session?.title || "New chat");
      const msgs: ChatMessage[] = (data.messages || []).map(
        (m: {
          id: string;
          role: "user" | "assistant";
          content: string;
          expandedQuery?: string | null;
          results?: RankedChunk[] | null;
          timing?: Timing | null;
          metrics?: Metrics | null;
          status?: string;
          createdAt?: string;
        }) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          expandedQuery: m.expandedQuery,
          results: m.results,
          timing: m.timing,
          metrics: m.metrics,
          status: m.status,
          createdAt: m.createdAt,
          evaluationStatus: m.metrics?.faithfulness != null ? ("completed" as const) : undefined,
          evaluationMs: m.metrics?.evaluationMs,
        }),
      );

      // If a message stream already started (pending first message after
      // create→navigate), keep optimistic messages instead of replacing with
      // empty history from a parallel load.
      if (statusRef.current === "running") {
        return;
      }

      // Prefer server history when idle. Only protect in-progress optimistic
      // temp messages for *this* load race (create→navigate→send).
      setMessages((prev) => {
        const hasLiveOptimistic =
          prev.some((m) => m.streaming || m.id.startsWith("temp-")) &&
          msgs.length === 0;
        if (hasLiveOptimistic) return prev;
        return msgs;
      });
      const lastAsst = [...msgs].reverse().find((m) => m.role === "assistant");
      setActiveAssistantId((prev) => {
        if (statusRef.current === "running") return prev;
        return lastAsst?.id ?? null;
      });
    } catch (err) {
      if (statusRef.current !== "running") {
        setError(err instanceof Error ? err.message : "Load failed");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- route changes reset chat state before hydration. */
  useEffect(() => {
    const prev = prevSessionIdRef.current;
    prevSessionIdRef.current = sessionId;
    const switching = prev !== undefined && prev !== sessionId;

    // Only abort an in-flight stream when navigating between different sessions.
    // Aborting on every mount races the "pending first message" flow: create session
    // on /search → store pendingSearch → push /search/:id → send starts → this effect
    // used to abort immediately and silently drop the message (AbortError is ignored).
    if (switching) {
      abortRef.current?.abort();
      statusRef.current = "idle";
      setStatus("idle");
      setError(null);
      setSteps(emptySteps());
      setLogs([]);
      setLastExpanded(null);
      // Clear previous chat immediately so we never show another session's turns
      // while history loads (and so temp- guards from a prior stream don't block hydrate).
      setMessages([]);
      setActiveAssistantId(null);
    }

    if (!sessionId) {
      setMessages([]);
      setSessionTitle("New chat");
      setActiveAssistantId(null);
      setStatus("idle");
      setError(null);
      setSteps(emptySteps());
      setLogs([]);
      setLastExpanded(null);
      setLoading(false);
      return;
    }

    void load(sessionId);
  }, [sessionId, load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    tokenBuf.current = "";
    if (flushTimer.current) clearTimeout(flushTimer.current);
    setStatus((s) => (s === "running" ? "failed" : s));
    setMessages((prev) =>
      prev.map((m) =>
        m.streaming ? { ...m, streaming: false, status: "failed" } : m,
      ),
    );
  }, []);

  const send = useCallback(
    async (
      query: string,
      opts?: {
        searchLimit?: number;
        contextTopK?: number;
        generateAnswer?: boolean;
        retrievalMode?: "bm25" | "adaptive_rrf" | "sgaf" | "legacy_rrf_ce";
        llmModel?: string;
      },
    ) => {
      if (!sessionId || !query.trim() || status === "running") return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      tokenBuf.current = "";
      if (flushTimer.current) clearTimeout(flushTimer.current);

      const tempUserId = `temp-u-${Date.now()}`;
      const tempAsstId = `temp-a-${Date.now()}`;
      streamAssistantId.current = tempAsstId;

      setStatus("running");
      setError(null);
      setSteps({
        expand: "running",
        search: "pending",
        fetch: "pending",
        chunk: "pending",
        retrieve: "pending",
        generate: "pending",
      });
      setLogs(["Connecting…"]);
      setLastExpanded(null);

      setMessages((prev) => [
        ...prev,
        {
          id: tempUserId,
          role: "user",
          content: query.trim(),
          status: "completed",
        },
        {
          id: tempAsstId,
          role: "assistant",
          content: "",
          results: [],
          streaming: true,
          status: "running",
        },
      ]);
      setActiveAssistantId(tempAsstId);

      try {
        const res = await fetch(`/api/search/sessions/${sessionId}/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify({
            query: query.trim(),
            searchLimit: opts?.searchLimit,
            contextTopK: opts?.contextTopK,
            generateAnswer: opts?.generateAnswer,
            retrievalMode: opts?.retrievalMode,
            llmModel: opts?.llmModel,
          }),
          signal: controller.signal,
          cache: "no-store",
        });

        if (!res.ok) {
          const text = await res.text();
          let message = text || `HTTP ${res.status}`;
          try {
            const j = JSON.parse(text) as { error?: string };
            if (j.error) message = j.error;
          } catch {
            /* */
          }
          throw new Error(message);
        }
        if (!res.body) throw new Error("Empty stream");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";

          for (const part of parts) {
            const line = part
              .split("\n")
              .map((l) => l.trim())
              .find((l) => l.startsWith("data:"));
            if (!line) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            let event: StreamEvent;
            try {
              event = JSON.parse(payload) as StreamEvent;
            } catch {
              continue;
            }

            if (event.type === "generation_token") {
              tokenBuf.current += event.token;
              scheduleFlush();
              setSteps((s) => ({ ...s, generate: "running" }));
              continue;
            }

            if (tokenBuf.current) {
              if (flushTimer.current) {
                clearTimeout(flushTimer.current);
                flushTimer.current = null;
              }
              flushTokens();
            }

            applyChatEvent(event, {
              setSteps,
              setLogs,
              setMessages,
              setError,
              setLastExpanded,
              setActiveAssistantId,
              tempUserId,
              tempAsstId,
              streamAssistantId,
            });
          }
        }

        if (tokenBuf.current) {
          if (flushTimer.current) {
            clearTimeout(flushTimer.current);
            flushTimer.current = null;
          }
          flushTokens();
        }

        // Only mark success when run_completed set status completed on the assistant.
        setMessages((prev) => {
          const asst = prev.find(
            (m) => m.id === streamAssistantId.current || m.streaming,
          );
          const succeeded = asst?.status === "completed" && !asst.streaming;
          return prev.map((m) => {
            if (m.id === streamAssistantId.current || m.streaming) {
              if (succeeded || m.status === "completed") {
                return { ...m, streaming: false, status: "completed" };
              }
              return {
                ...m,
                streaming: false,
                status: "failed",
                content:
                  m.content ||
                  "Stream ended without a completed answer. Please retry.",
              };
            }
            return m;
          });
        });
        setStatus((s) => (s === "running" ? "idle" : s));
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          setStatus((s) => (s === "running" ? "failed" : s));
          setMessages((prev) =>
            prev.map((m) =>
              m.streaming
                ? { ...m, streaming: false, status: "failed" }
                : m,
            ),
          );
          return;
        }
        const message = err instanceof Error ? err.message : "Request failed";
        setStatus("failed");
        setError(message);
        setMessages((prev) =>
          prev.map((m) =>
            m.streaming
              ? {
                  ...m,
                  streaming: false,
                  status: "failed",
                  content: m.content || `Error: ${message}`,
                }
              : m,
          ),
        );
      }
    },
    [sessionId, status, flushTokens, scheduleFlush],
  );

  const activeEvidence =
    messages.find((m) => m.id === activeAssistantId && m.role === "assistant")
      ?.results || [];

  return {
    messages,
    sessionTitle,
    loading,
    status,
    error,
    steps,
    logs,
    activeAssistantId,
    setActiveAssistantId,
    activeEvidence,
    lastExpanded,
    send,
    cancel,
    setMessages,
    reload: () => (sessionId ? load(sessionId) : Promise.resolve()),
  };
}

function applyChatEvent(
  event: StreamEvent,
  ctx: {
    setSteps: Dispatch<SetStateAction<StepMap>>;
    setLogs: Dispatch<SetStateAction<string[]>>;
    setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
    setError: Dispatch<SetStateAction<string | null>>;
    setLastExpanded: Dispatch<
      SetStateAction<{
        original: string;
        expanded: string;
        usedContext: boolean;
      } | null>
    >;
    setActiveAssistantId: Dispatch<SetStateAction<string | null>>;
    tempUserId: string;
    tempAsstId: string;
    streamAssistantId: MutableRefObject<string | null>;
  },
) {
  const {
    setSteps,
    setLogs,
    setMessages,
    setError,
    setLastExpanded,
    setActiveAssistantId,
    tempUserId,
    tempAsstId,
    streamAssistantId,
  } = ctx;

  switch (event.type) {
    case "query_expanded":
      setSteps((s) => ({ ...s, expand: "success", search: "running" }));
      setLogs((l) => [
        ...l,
        event.usedContext
          ? `Expanded: “${event.original}” → “${event.expanded}” (${event.method})`
          : `Query: ${event.expanded}`,
      ]);
      setLastExpanded({
        original: event.original,
        expanded: event.expanded,
        usedContext: event.usedContext,
      });
      setMessages((prev) =>
        prev.map((m) =>
          m.id === tempUserId
            ? { ...m, expandedQuery: event.expanded }
            : m,
        ),
      );
      break;
    case "search_started":
      setSteps((s) => ({ ...s, search: "running" }));
      setLogs((l) => [...l, `Search: ${event.query}`]);
      break;
    case "search_completed":
      setSteps((s) => ({
        ...s,
        search: "success",
        fetch: "running",
      }));
      setLogs((l) => [
        ...l,
        `Search done (${event.count} hits, ${event.ms}ms)`,
      ]);
      break;
    case "fetch_completed":
      setSteps((s) => ({ ...s, fetch: "success", chunk: "running" }));
      setLogs((l) => [
        ...l,
        `Content ready (${event.pages} pages, ${event.ms}ms)`,
      ]);
      break;
    case "chunk_completed":
      setSteps((s) => ({ ...s, chunk: "success", retrieve: "running" }));
      setLogs((l) => [...l, `Chunked ${event.chunks} (${event.ms}ms)`]);
      break;
    case "retrieve_completed":
      setSteps((s) => ({ ...s, retrieve: "success" }));
      setLogs((l) => [
        ...l,
        `Retrieved ${event.results.length} evidence (${event.ms}ms)`,
      ]);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === (streamAssistantId.current || tempAsstId)
            ? { ...m, results: event.results }
            : m,
        ),
      );
      break;
    case "generation_started":
      setSteps((s) => ({ ...s, generate: "running" }));
      setLogs((l) => [...l, "Generating…"]);
      break;
    case "run_completed": {
      setSteps((s) => ({
        ...s,
        expand: "success",
        search: "success",
        fetch: "success",
        chunk: "success",
        retrieve: "success",
        generate: event.metrics.llmUsed ? "success" : s.generate,
      }));
      setLogs((l) => [
        ...l,
        `Completed in ${event.timing.totalMs ?? "?"}ms`,
      ]);
      const userId = event.messageIds?.userId || tempUserId;
      const asstId = event.messageIds?.assistantId || tempAsstId;
      streamAssistantId.current = asstId;
      setActiveAssistantId(asstId);
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id === tempUserId || m.id === userId) {
            return {
              ...m,
              id: userId,
              expandedQuery: event.expandedQuery || m.expandedQuery,
              streaming: false,
            };
          }
          if (m.id === tempAsstId || m.id === asstId) {
            return {
              ...m,
              id: asstId,
              content: event.answer || m.content,
              results: event.results,
              timing: event.timing,
              metrics: event.metrics,
              streaming: false,
              status: "completed",
            };
          }
          return m;
        }),
      );
      break;
    }
    case "error":
      setError(event.message);
      setLogs((l) => [...l, `Error: ${event.message}`]);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === (streamAssistantId.current || tempAsstId) || m.streaming
            ? {
                ...m,
                streaming: false,
                status: m.status === "completed" ? m.status : "failed",
                content: m.content || `Error: ${event.message}`,
              }
            : m,
        ),
      );
      break;
    default:
      break;
  }
}
