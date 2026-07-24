"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  Database,
  FileSearch,
  Gauge,
  Menu,
  PanelLeft,
  PanelRight,
  Sparkles,
  Workflow,
  Upload,
  X,
} from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DatasetComposer } from "@/components/dataset/DatasetComposer";
import { DatasetSidebar, type DatasetSummary } from "@/components/dataset/DatasetSidebar";
import { DocumentResultsList } from "@/components/dataset/DocumentResultsList";
import { RunMetricsStrip } from "@/components/dataset/RunMetricsStrip";
import { UploadPipelinePanel } from "@/components/dataset/UploadPipelinePanel";
import {
  readStoredRetrievalMode,
  storeRetrievalMode,
  type RetrievalModeId,
} from "@/lib/ir/retrieval-modes";
import { LoadingOverlay } from "@/components/LoadingOverlay";
import { ModeSwitcher } from "@/components/ModeSwitcher";
import { ResizeHandle } from "@/components/ResizeHandle";
import { ChatThread } from "@/components/search/ChatThread";
import { StepRail } from "@/components/StepRail";
import type { ChatMessage } from "@/lib/hooks/use-search-chat";
import { usePanelLayout } from "@/lib/hooks/use-panel-layout";
import { useSsePipeline } from "@/lib/hooks/use-sse";
import { useUploadSse } from "@/lib/hooks/use-upload-sse";
import type { RankedDocument } from "@/lib/ir/types";
import { cn } from "@/lib/utils";
import { UPLOAD_DEFAULTS } from "@/lib/upload-config";

const DeferredPanel = () => (
  <div className="min-h-24 animate-pulse rounded-xl bg-[var(--bg-panel)]" aria-label="Loading panel" />
);

const SourceManager = dynamic(
  () => import("@/components/dataset/SourceManager").then((mod) => mod.SourceManager),
  { ssr: false, loading: DeferredPanel },
);
const PipelineInspector = dynamic(
  () => import("@/components/pipeline/PipelineInspector").then((mod) => mod.PipelineInspector),
  { ssr: false, loading: DeferredPanel },
);
const ProcessExplainPanel = dynamic(
  () => import("@/components/dataset/ProcessExplainPanel").then((mod) => mod.ProcessExplainPanel),
  { ssr: false, loading: DeferredPanel },
);
const DocumentDetailDrawer = dynamic(
  () => import("@/components/dataset/DocumentDetailDrawer").then((mod) => mod.DocumentDetailDrawer),
  { ssr: false, loading: () => null },
);

type Source = {
  id: string;
  title: string;
  mime: string | null;
  charCount: number;
  createdAt: string;
};

const SUGGESTIONS = [
  "Summarize the main points in this corpus",
  "Compare BM25 and dense retrieval in the documents",
  "What are the key concepts?",
];

export function DatasetChatLayout({
  notebookId,
}: {
  notebookId: string | null;
}) {
  const router = useRouter();
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [datasetsLoading, setDatasetsLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uiError, setUiError] = useState<string | null>(null);
  /** Mobile overlay for datasets list (narrow screens). */
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const panel = usePanelLayout({ storageKey: "dataset-chat" });
  const [rightTab, setRightTab] = useState<"sources" | "evidence" | "process">(
    "sources",
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeAssistantId, setActiveAssistantId] = useState<string | null>(
    null,
  );
  const [selectedDoc, setSelectedDoc] = useState<RankedDocument | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** Checked datasets included in retrieval (multi-select from DB list) */
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [retrievalMode, setRetrievalMode] = useState<RetrievalModeId>(
    () => readStoredRetrievalMode(),
  );
  const initialNavigationType = useRef<PerformanceNavigationTiming["type"] | null>(
    null,
  );

  const { state, run, cancel, reset } = useSsePipeline();
  const uploadSse = useUploadSse();
  const { state: uploadState, upload, uploadDirect } = uploadSse;
  // Only use direct Storage for all files when explicitly enabled. The size
  // gate below still protects Vercel for large files when the public flag is
  // missing, while small local uploads keep the legacy fallback path.
  const directStorageUploads =
    process.env.NEXT_PUBLIC_DIRECT_STORAGE_UPLOADS === "0"
      ? false
      : UPLOAD_DEFAULTS.directStorageUploads;

  const onRetrievalModeChange = useCallback((mode: RetrievalModeId) => {
    setRetrievalMode(mode);
    storeRetrievalMode(mode);
  }, []);

  const loadDatasets = useCallback(async () => {
    setDatasetsLoading(true);
    try {
      const res = await fetch("/api/notebooks", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load datasets");
      const items = (Array.isArray(data.items) ? data.items : []).map(
        (n: {
          id: string;
          title: string;
          createdAt: string;
          updatedAt?: string;
          locked?: boolean;
        }) => ({
          id: n.id,
          title: n.title,
          createdAt: n.createdAt,
          updatedAt: n.updatedAt || n.createdAt,
          locked: n.locked,
        }),
      );
      setDatasets(items);
    } catch (err) {
      setUiError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setDatasetsLoading(false);
    }
  }, []);

  const loadNotebook = useCallback(async (id: string) => {
    setLoadError(null);
    try {
      const res = await fetch(`/api/notebooks/${id}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Notebook not found");
      setTitle(data.notebook?.title || "Dataset");
      setSources(data.sources || []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load");
    }
  }, []);

  const loadChatHistory = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/notebooks/${id}/messages`, {
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessages([]);
        setActiveAssistantId(null);
        const errMsg =
          (data as { error?: string }).error ||
          "Failed to load chat history from database";
        setUiError(errMsg);
        return;
      }
      const msgs: ChatMessage[] = (data.messages || []).map(
        (m: {
          id: string;
          role: "user" | "assistant";
          content: string;
          results?: ChatMessage["results"];
          timing?: ChatMessage["timing"];
          metrics?: ChatMessage["metrics"];
          status?: string;
          createdAt?: string;
        }) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          results: m.results || undefined,
          timing: m.timing || undefined,
          metrics: m.metrics || undefined,
          status: m.status,
          createdAt: m.createdAt,
        }),
      );
      setMessages(msgs);
      const lastAsst = [...msgs].reverse().find((m) => m.role === "assistant");
      setActiveAssistantId(lastAsst?.id ?? null);
    } catch {
      setMessages([]);
      setActiveAssistantId(null);
    }
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- API load owns async UI state. */
  useEffect(() => {
    void loadDatasets();
  }, [loadDatasets]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Keep checkbox selection in sync with known datasets; auto-check active open id
  /* eslint-disable react-hooks/set-state-in-effect -- reconcile selection with API results. */
  useEffect(() => {
    setCheckedIds((prev) => {
      const valid = new Set(datasets.map((d) => d.id));
      let next = prev.filter((id) => valid.has(id));
      if (notebookId && valid.has(notebookId) && !next.includes(notebookId)) {
        next = [...next, notebookId];
      }
      // First load: if nothing checked and we have list but no open notebook, leave empty
      return next;
    });
  }, [datasets, notebookId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /* eslint-disable react-hooks/set-state-in-effect -- reset local workspace on route change. */
  useEffect(() => {
    if (initialNavigationType.current === null) {
      const navigation = performance.getEntriesByType("navigation")[0] as
        | PerformanceNavigationTiming
        | undefined;
      initialNavigationType.current = navigation?.type || "navigate";
    }

    reset();
    setMessages([]);
    setActiveAssistantId(null);
    setSelectedDoc(null);
    setDrawerOpen(false);
    setSources([]);
    setTitle("");
    if (notebookId) {
      void loadNotebook(notebookId);
      // A browser reload starts a fresh visible conversation on this page.
      // Keep the durable history untouched and preserve history hydration for
      // normal in-app notebook navigation.
      if (initialNavigationType.current !== "reload") {
        void loadChatHistory(notebookId);
      }
    }
  }, [notebookId, loadNotebook, loadChatHistory, reset]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Sync streaming answer into chat messages
  /* eslint-disable react-hooks/set-state-in-effect -- stream events update the visible transcript. */
  useEffect(() => {
    if (!activeAssistantId) return;
    if (state.status === "running" || state.status === "completed") {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === activeAssistantId
            ? {
                ...m,
                content: state.answer || m.content,
                streaming: state.status === "running",
                timing: state.timing,
                metrics: state.metrics,
                results: state.results,
              }
            : m,
        ),
      );
    }
  }, [
    state.answer,
    state.status,
    state.timing,
    state.metrics,
    state.results,
    activeAssistantId,
  ]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const goDataset = useCallback(
    (id: string | null) => {
      setMobileSidebarOpen(false);
      if (!id) router.push("/notebooks");
      else router.push(`/notebooks/${id}`);
    },
    [router],
  );

  const onNew = useCallback(async () => {
    setUiError(null);
    setCreating(true);
    try {
      const name = `Dataset ${new Date().toLocaleString()}`;
      const res = await fetch("/api/notebooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Create failed");
      await loadDatasets();
      goDataset(data.id as string);
    } catch (err) {
      setUiError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setCreating(false);
    }
  }, [goDataset, loadDatasets]);

  const requestDelete = useCallback((id: string, name: string) => {
    setUiError(null);
    setPendingDelete({ id, title: name });
  }, []);

  const onToggleCheck = useCallback((id: string, checked: boolean) => {
    setCheckedIds((prev) => {
      if (checked) return prev.includes(id) ? prev : [...prev, id];
      return prev.filter((x) => x !== id);
    });
  }, []);

  const onRename = useCallback(async (id: string, newTitle: string) => {
    setUiError(null);
    const res = await fetch(`/api/notebooks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: newTitle }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        (data as { error?: string }).error || "Rename failed",
      );
    }
    setDatasets((prev) =>
      prev.map((d) =>
        d.id === id
          ? {
              ...d,
              title: (data as { title?: string }).title || newTitle,
              updatedAt:
                (data as { updatedAt?: string }).updatedAt || d.updatedAt,
            }
          : d,
      ),
    );
    if (notebookId === id) {
      setTitle((data as { title?: string }).title || newTitle);
    }
  }, [notebookId]);

  /**
   * Optimistic delete: remove from UI immediately, DELETE runs in background.
   * On failure, restore the row and surface an error (no long wait on confirm).
   */
  const confirmDelete = () => {
    if (!pendingDelete) return;
    const { id, title: deletedTitle } = pendingDelete;
    const snapshot = datasets.find((d) => d.id === id);

    // 1) Instant UI feedback
    setPendingDelete(null);
    setDeleting(false);
    setUiError(null);
    setDatasets((prev) => prev.filter((d) => d.id !== id));
    setCheckedIds((prev) => prev.filter((x) => x !== id));
    if (notebookId === id) goDataset(null);

    // 2) Background persistence — user is not blocked
    void (async () => {
      try {
        const res = await fetch(`/api/notebooks/${id}`, { method: "DELETE" });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(
            (data as { error?: string }).error || "Delete failed",
          );
        }
        // Soft reconcile list later (quiet) without blocking UI
        void loadDatasets();
      } catch (err) {
        // Roll back optimistic removal
        if (snapshot) {
          setDatasets((prev) => {
            if (prev.some((d) => d.id === id)) return prev;
            return [snapshot, ...prev].sort((a, b) =>
              (b.updatedAt || b.createdAt).localeCompare(
                a.updatedAt || a.createdAt,
              ),
            );
          });
        } else {
          void loadDatasets();
        }
        setUiError(
          err instanceof Error
            ? `Could not delete “${deletedTitle}”: ${err.message}`
            : `Could not delete “${deletedTitle}”`,
        );
      }
    })();
  };

  const onUpload = useCallback(async (file: File) => {
    if (!notebookId) {
      setUiError("Create or select a dataset first.");
      return;
    }
    setUiError(null);
    setRightTab("sources");
    try {
      // Keep large files out of the Vercel Function request body.
      const requiresDirectUpload =
        directStorageUploads ||
        file.size > UPLOAD_DEFAULTS.directUploadThresholdBytes;
      if (requiresDirectUpload) {
        await uploadDirect(`/api/notebooks/${notebookId}/upload`, file);
      } else {
        await upload(`/api/notebooks/${notebookId}/upload`, file);
      }
      await loadNotebook(notebookId);
      await loadDatasets();
    } catch (err) {
      setUiError(err instanceof Error ? err.message : "Upload failed");
    }
  }, [directStorageUploads, loadDatasets, loadNotebook, notebookId, upload, uploadDirect]);

  const onSend = useCallback(async (
    query: string,
    opts: { retrievalMode: RetrievalModeId; llmModel?: string },
  ) => {
    // Prefer checked datasets; fall back to the open workspace
    const corpus =
      checkedIds.length > 0
        ? checkedIds
        : notebookId
          ? [notebookId]
          : [];
    if (!corpus.length) {
      setUiError("Tick at least one dataset in the left sidebar to chat.");
      return;
    }
    // History / stream host: open notebook if checked, else first checked id.
    // Do NOT navigate here — changing notebookId remounts chat and aborts the stream.
    const hostId =
      notebookId && corpus.includes(notebookId) ? notebookId : corpus[0];
    if (notebookId === hostId && !sources.length && corpus.length === 1) {
      setUiError("Upload at least one document before chatting.");
      setRightTab("sources");
      return;
    }
    setUiError(null);
    setDrawerOpen(false);

    const userId = `u-${crypto.randomUUID()}`;
    const asstId = `a-${crypto.randomUUID()}`;
    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", content: query },
      {
        id: asstId,
        role: "assistant",
        content: "",
        streaming: true,
      },
    ]);
    setActiveAssistantId(asstId);
    setRightTab("evidence");

    const extra = corpus.filter((id) => id !== hostId);
    await run(`/api/notebooks/${hostId}/ask`, {
      query,
      generateAnswer: true,
      contextTopK: 4,
      documentTopK: 10,
      retrieveTopK: 40,
      retrievalMode: opts.retrievalMode,
      llmModel: opts.llmModel,
      ...(extra.length ? { notebookIds: extra } : {}),
    });
  }, [checkedIds, notebookId, run, sources.length]);

  // Query-time retrieval unit count only (upload always stores 0 chunks).
  const retrievalUnitCount =
    state.metrics?.chunkCount != null && state.metrics.chunkCount > 0
      ? state.metrics.chunkCount
      : undefined;
  const totalChars = sources.reduce((n, s) => n + (s.charCount || 0), 0);

  const notebookSteps = useMemo(
    () => ({
      corpus:
        sources.length > 0 || checkedIds.length > 0
          ? ("success" as const)
          : ("pending" as const),
      query: state.steps.query || ("pending" as const),
      retrieve: state.steps.retrieve || ("pending" as const),
      embedding: state.steps.embedding || ("pending" as const),
      fusion: state.steps.fusion || ("pending" as const),
      pack: state.steps.pack || ("pending" as const),
      generate: state.steps.generate || ("pending" as const),
    }),
    [checkedIds.length, sources.length, state.steps],
  );

  // The root dataset workspace can query checked datasets without a single
  // `notebookId`. Retrieval state is still fully available from the SSE run,
  // so the inspector must follow pipeline activity rather than route shape.
  const hasPipelineActivity =
    messages.length > 0 ||
    state.status !== "idle" ||
    state.logs.length > 0 ||
    Object.values(notebookSteps).some(
      (step) => step === "success" || step === "failed" || step === "running",
    );
  const showWorkspaceInspector = Boolean(notebookId || hasPipelineActivity);
  const selectedCorpusCount = notebookId ? sources.length : checkedIds.length;
  const recommendationTitles = useMemo(() => {
    const titles = notebookId
      ? sources.map((source) => source.title)
      : datasets
          .filter((dataset) => checkedIds.includes(dataset.id))
          .map((dataset) => dataset.title);
    const uniqueTitles = [...new Set(titles.filter(Boolean))].slice(0, 6);
    return uniqueTitles.flatMap((name) => [
      `Summarize ${name}`,
      `What are the key points in ${name}?`,
      `Find relevant content in ${name}`,
    ]);
  }, [checkedIds, datasets, notebookId, sources]);
  const recommendationIds = useMemo(
    () => (notebookId ? [notebookId] : checkedIds),
    [checkedIds, notebookId],
  );

  const uploading = uploadState.status === "running";
  const running = state.status === "running";
  const {
    leftOpen,
    rightOpen,
    leftWidth,
    rightWidth,
    toggleLeft,
    toggleRight,
    openLeft,
    closeLeft,
    openRight,
    closeRight,
    beginResize,
  } = panel;

  const activeMsg = messages.find((m) => m.id === activeAssistantId);
  const handleSelectAssistant = useCallback((id: string) => {
    setActiveAssistantId(id);
    setRightTab("evidence");
  }, []);
  const handleUpdateMessage = useCallback(
    (msgId: string, update: Partial<ChatMessage>) => {
      setMessages((prev) =>
        prev.map((msg) => (msg.id === msgId ? { ...msg, ...update } : msg)),
      );
    },
    [],
  );
  const handleUpload = useCallback(
    (file: File) => {
      void onUpload(file);
    },
    [onUpload],
  );
  const refreshNotebook = useCallback(() => {
    return notebookId ? loadNotebook(notebookId) : Promise.resolve();
  }, [loadNotebook, notebookId]);

  return (
    <AppShell fill>
      <LoadingOverlay
        show={creating || uploading || running}
        label={
          creating
            ? "Creating dataset…"
            : uploading
              ? "Storing raw document…"
              : state.steps.generate === "running"
                ? "Generating answer…"
                : "Ranking documents…"
        }
      />

      <div className="flex min-h-0 min-w-0 flex-1">
        {/* Mobile datasets drawer backdrop */}
        {mobileSidebarOpen && (
          <button
            type="button"
            className="fixed inset-0 z-40 bg-slate-900/30 xl:hidden"
            aria-label="Close datasets"
            onClick={() => setMobileSidebarOpen(false)}
          />
        )}

        {/* Desktop collapsed rail — reopen datasets */}
        {!leftOpen && (
          <div className="panel-rail hidden xl:flex" aria-label="Datasets collapsed">
            <button
              type="button"
              className="panel-rail-btn"
              onClick={openLeft}
              aria-label="Expand datasets panel"
              title="Expand datasets"
            >
              <PanelLeft className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Datasets sidebar — resizable + collapsible on xl; drawer on mobile */}
        <div
          className={cn(
            "dataset-sidebar-panel panel-shell z-50 bg-[var(--bg-elevated)]",
            "fixed inset-y-0 left-0 pt-14 transition-transform xl:static xl:pt-0",
            mobileSidebarOpen
              ? "translate-x-0"
              : "-translate-x-full xl:translate-x-0",
            !leftOpen && "is-collapsed",
          )}
          style={{ width: leftWidth }}
        >
          <DatasetSidebar
            items={datasets}
            currentId={notebookId}
            checkedIds={checkedIds}
            loading={datasetsLoading}
            onNew={() => void onNew()}
            onSelect={(id) => {
              goDataset(id);
              setMobileSidebarOpen(false);
              // Opening a dataset also includes it in retrieval
              setCheckedIds((prev) =>
                prev.includes(id) ? prev : [...prev, id],
              );
            }}
            onToggleCheck={onToggleCheck}
            onRename={onRename}
            onDelete={requestDelete}
            onCollapse={closeLeft}
            className="h-full border-0"
          />
          {leftOpen && (
            <div className="absolute inset-y-0 right-0 hidden xl:block">
              <ResizeHandle
                side="left"
                label="Resize datasets panel"
                onResizeStart={(e) => beginResize("left", e)}
              />
            </div>
          )}
        </div>

        {/* Main chat column */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--bg-base)]">
          <div className="chat-toolbar">
            <button
              type="button"
              className="btn-ghost !min-h-9 !rounded-lg !px-2 xl:hidden"
              onClick={() => setMobileSidebarOpen(true)}
              aria-label="Open datasets"
            >
              <Menu className="h-4 w-4" />
            </button>
            <button
              type="button"
              className={cn(
                "btn-ghost !min-h-9 !rounded-lg !px-2 hidden xl:inline-flex",
                leftOpen &&
                  "bg-[var(--accent-soft)] text-[var(--fg)] ring-1 ring-[var(--accent-border)]",
              )}
              onClick={toggleLeft}
              aria-label={leftOpen ? "Collapse datasets" : "Expand datasets"}
              aria-pressed={leftOpen}
              title={leftOpen ? "Collapse datasets" : "Expand datasets"}
            >
              <PanelLeft className="h-4 w-4" />
              <span className="hidden sm:inline">Datasets</span>
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div
                  className="truncate text-sm font-semibold tracking-tight text-[var(--fg)]"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {notebookId ? title || "Dataset chat" : "Dataset search"}
                </div>
              </div>
              {notebookId ? (
                <div className="truncate text-[11px] text-[var(--fg-subtle)]">
                  {sources.length} raw source
                  {sources.length === 1 ? "" : "s"} · full-text at query time ·
                  no pre-index
                </div>
              ) : (
                <div className="truncate text-[11px] text-[var(--fg-subtle)]">
                  Upload documents · rank · cited answers
                </div>
              )}
            </div>
            {showWorkspaceInspector && (
              <button
                type="button"
                className={cn(
                  "btn-ghost !min-h-9 !rounded-lg !px-2",
                  rightOpen &&
                    "bg-[var(--accent-soft)] text-[var(--fg)] ring-1 ring-[var(--accent-border)]",
                )}
                onClick={toggleRight}
                aria-label={rightOpen ? "Collapse side panel" : "Expand side panel"}
                aria-pressed={rightOpen}
                title={rightOpen ? "Collapse panel" : "Expand panel"}
              >
                <PanelRight className="h-4 w-4" />
                <span className="hidden sm:inline">Inspector</span>
              </button>
            )}
          </div>

          {(uiError || loadError || state.error || uploadState.error) && (
            <div
              role="alert"
              className={cn(
                "alert m-3 shrink-0",
                /token|context length|maximum context/i.test(
                  uiError || loadError || state.error || uploadState.error || "",
                )
                  ? "alert-warn"
                  : "alert-error",
              )}
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 break-words line-clamp-3">
                {uiError || loadError || state.error || uploadState.error}
              </span>
            </div>
          )}

          {showWorkspaceInspector && (
            <StepRail steps={notebookSteps} timing={state.timing} />
          )}

          <ChatThread
            messages={messages}
            activeAssistantId={activeAssistantId}
            onSelectAssistant={handleSelectAssistant}
            messageType="notebook"
            onUpdateMessage={handleUpdateMessage}
            empty={
              <div className="chat-empty workspace-empty workspace-empty--dataset anim-enter">
                <div className="workspace-empty-head">
                  <div className="chat-empty-badge">
                    <Sparkles className="h-3 w-3 text-[var(--violet)]" />
                    Dataset workspace
                  </div>
                  <span className="workspace-live-status">
                    <span className="workspace-status-dot" />
                    Retrieval system ready
                  </span>
                </div>
                <div className="workspace-mode-switcher">
                  <ModeSwitcher current="dataset" />
                </div>
                <h2 className="chat-empty-title workspace-empty-title">
                  {notebookId
                    ? sources.length
                      ? "Ask your documents"
                      : "Store a source to begin"
                    : "Build your research workspace"}
                </h2>
                <p className="chat-empty-copy workspace-empty-copy">
                  {notebookId
                    ? sources.length
                      ? "Retrieval runs over full source text at query time. Upload only stores raw documents — no pre-chunk or embed index."
                      : "Attach PDF, TXT, MD, CSV or JSON. Text is extracted and stored raw; ranking starts when you ask."
                    : "Collect source material, inspect the ranking pipeline, and ask grounded questions from one focused canvas."}
                </p>
                <div className="workspace-kpis anim-stagger" aria-label="Workspace overview">
                  <div className="workspace-kpi workspace-kpi--violet">
                    <span className="workspace-kpi-icon"><Database className="h-4 w-4" /></span>
                    <span className="workspace-kpi-value">{notebookId ? sources.length : datasets.length}</span>
                    <span className="workspace-kpi-label">{notebookId ? "Raw sources" : "Datasets ready"}</span>
                  </div>
                  <div className="workspace-kpi workspace-kpi--cyan">
                    <span className="workspace-kpi-icon"><FileSearch className="h-4 w-4" /></span>
                    <span className="workspace-kpi-value">BM25</span>
                    <span className="workspace-kpi-label">Query-time ranking</span>
                  </div>
                  <div className="workspace-kpi workspace-kpi--amber">
                    <span className="workspace-kpi-icon"><Gauge className="h-4 w-4" /></span>
                    <span className="workspace-kpi-value">Live</span>
                    <span className="workspace-kpi-label">Pipeline metrics</span>
                  </div>
                </div>
                <div className="workspace-flow" aria-label="Dataset workflow">
                  <div className="workspace-flow-label"><Workflow className="h-4 w-4" /> Research flow</div>
                  <div className="workspace-flow-steps">
                    <div className="workspace-flow-step workspace-flow-step--active"><span>01</span><strong>Collect</strong><small>Upload raw files</small></div>
                    <ArrowUpRight className="workspace-flow-arrow" aria-hidden />
                    <div className="workspace-flow-step"><span>02</span><strong>Retrieve</strong><small>Rank at query time</small></div>
                    <ArrowUpRight className="workspace-flow-arrow" aria-hidden />
                    <div className="workspace-flow-step"><span>03</span><strong>Ground</strong><small>Inspect evidence</small></div>
                  </div>
                </div>
                <div className="chat-empty-actions anim-stagger">
                  {notebookId &&
                    sources.length > 0 &&
                    SUGGESTIONS.map((s, i) => (
                      <button
                        key={s}
                        type="button"
                        className={cn(
                          "chip",
                          i % 3 === 0 && "chip-tint-violet",
                          i % 3 === 1 && "chip-tint-cyan",
                          i % 3 === 2 && "chip-tint-amber",
                        )}
                        disabled={running}
                        onClick={() =>
                          void onSend(s, { retrievalMode })
                        }
                      >
                        {s}
                      </button>
                    ))}
                  {notebookId && !sources.length && (
                    <label className="hover-lift inline-flex cursor-pointer flex-col items-center gap-2 rounded-2xl border border-dashed border-[var(--violet-border)] bg-[var(--violet-soft)] px-7 py-7 text-xs text-[var(--fg-muted)] shadow-sm transition hover:border-[var(--mood-border)] hover:bg-[var(--mood-soft)]">
                      <Upload className="h-6 w-6 text-[var(--violet)]" />
                      <span className="text-sm font-semibold text-[var(--fg)]">
                        Store first raw source
                      </span>
                      <span className="text-[var(--fg-subtle)]">
                        PDF · TXT · MD · CSV · JSON
                      </span>
                      <input
                        type="file"
                        className="hidden"
                        accept=".pdf,.txt,.md,.markdown,.csv,.json,text/plain,text/csv,application/pdf,application/csv"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void onUpload(f);
                        }}
                      />
                    </label>
                  )}
                  {!notebookId && (
                    <div className="workspace-empty-hint"><CheckCircle2 className="h-4 w-4" /> Select a dataset from the left panel, or create a new one to start.</div>
                  )}
                </div>
              </div>
            }
          />

          <DatasetComposer
            disabled={!notebookId && checkedIds.length === 0}
            running={running}
            uploading={uploading}
            onSend={onSend}
            onCancel={cancel}
            onUpload={notebookId ? handleUpload : undefined}
            suggestions={recommendationTitles}
            recommendationIds={recommendationIds}
            retrievalMode={retrievalMode}
            onRetrievalModeChange={onRetrievalModeChange}
            placeholder={
              checkedIds.length === 0 && !notebookId
                ? "Tick datasets on the left, then ask…"
                : notebookId && !sources.length && checkedIds.length <= 1
                  ? "Store a raw source first (paperclip)…"
                  : checkedIds.length > 1
                    ? `Ask across ${checkedIds.length} selected datasets…`
                    : "Ask about your stored sources…"
            }
          />
      </div>

      {showWorkspaceInspector && rightOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-slate-900/35 xl:hidden"
          aria-label="Close inspector"
          onClick={closeRight}
        />
      )}

      {/* Collapsed right rail — reopen Sources / Evidence / Process */}
        {showWorkspaceInspector && !rightOpen && (
          <div
            className="panel-rail panel-rail--right hidden xl:flex"
            aria-label="Side panel collapsed"
          >
            <button
              type="button"
              className="panel-rail-btn"
              onClick={openRight}
              aria-label="Expand side panel"
              title="Expand panel"
            >
              <PanelRight className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Right panel — sources / evidence / process (resizable + collapsible) */}
        {showWorkspaceInspector && (
          <aside
            className={cn(
              "dataset-inspector chat-panel panel-shell shrink-0 xl:relative",
              rightOpen
                ? "fixed bottom-0 left-[var(--rail-w)] right-0 z-50 flex h-[min(82dvh,44rem)] w-auto rounded-t-2xl shadow-[var(--shadow-lg)] xl:static xl:inset-auto xl:h-full xl:w-auto xl:rounded-none xl:shadow-none"
                : "hidden xl:flex",
              !rightOpen && "is-collapsed",
            )}
            style={{ "--inspector-width": `${rightWidth}px` } as CSSProperties}
            aria-hidden={!rightOpen}
          >
            {rightOpen && (
              <ResizeHandle
                side="right"
                label="Resize side panel"
                onResizeStart={(e) => beginResize("right", e)}
              />
            )}
            <div className="dataset-inspector-header">
              <div className="min-w-0">
                <span className="dataset-inspector-kicker">Workspace inspector</span>
                <strong className="dataset-inspector-title truncate">
                  {notebookId ? title || "Dataset workspace" : "Selected corpus"}
                </strong>
              </div>
              <span className={cn(
                "dataset-inspector-status",
                running ? "dataset-inspector-status--running" : "dataset-inspector-status--ready",
              )}>
                <span aria-hidden />
                {running ? "Running" : "Ready"}
              </span>
              <button
                type="button"
                className="dataset-inspector-close"
                onClick={closeRight}
                aria-label="Close inspector"
                title="Close inspector"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="chat-panel-tabs">
              {(
                [
                  ["sources", "Sources", Database, sources.length],
                  ["evidence", "Evidence", FileSearch, state.documents.length],
                  ["process", "Process", Workflow, null],
                ] as const
              ).map(([id, label, Icon, count]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setRightTab(id)}
                  role="tab"
                  aria-selected={rightTab === id}
                  aria-controls={`inspector-panel-${id}`}
                  className={cn(
                    "chat-panel-tab dataset-inspector-tab",
                    rightTab === id && "chat-panel-tab--active",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden />
                  <span>{label}</span>
                  {count !== null && <em>{count}</em>}
                </button>
              ))}
            </div>
            <div className="dataset-inspector-body min-h-0 flex-1 overflow-y-auto p-3">
              {rightTab === "sources" && (
                <div id="inspector-panel-sources" role="tabpanel" className="space-y-3">
                  <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-panel)] px-2.5 py-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-subtle)]">
                      {notebookId ? "Corpus" : "Selected corpus"}
                    </p>
                    <p className="mt-1 text-[12px] text-[var(--fg)]">
                      <strong>{selectedCorpusCount}</strong>{" "}
                      {notebookId ? "raw source" : "dataset"}
                      {selectedCorpusCount === 1 ? "" : "s"}
                      {totalChars > 0 && (
                        <>
                          {" · "}
                          <span className="font-mono text-[11px] text-[var(--fg-muted)]">
                            {totalChars.toLocaleString()} chars
                          </span>
                        </>
                      )}
                    </p>
                    <p className="mt-0.5 text-[10px] leading-relaxed text-[var(--fg-subtle)]">
                      {notebookId
                        ? "Durable store is full document text only. Chunking and embedding are not written at upload; ranking builds units at query time."
                        : "Retrieval runs across the checked datasets. Raw documents remain stored in each dataset and ranking builds units at query time."}
                    </p>
                  </div>
                  {notebookId && (
                    <>
                      <UploadPipelinePanel state={uploadState} />
                      <SourceManager
                        notebookId={notebookId}
                        sources={sources}
                        uploadState={uploadState}
                        onUpload={onUpload}
                        onRefresh={refreshNotebook}
                      />
                    </>
                  )}
                  {!sources.length && !notebookId && (
                    <ul className="space-y-1.5">
                      <li className="py-2 text-xs text-[var(--fg-muted)]">
                        {selectedCorpusCount > 0
                          ? "Checked datasets are active for this retrieval run. Open one dataset to inspect or upload its raw sources."
                          : "No dataset is selected for retrieval yet."}
                      </li>
                    </ul>
                  )}
                </div>
              )}
              {rightTab === "evidence" && (
                <div id="inspector-panel-evidence" role="tabpanel" className="space-y-5">
                  <div>
                    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-subtle)]">
                      Run overview
                    </h3>
                    <div className="mt-2">
                      <RunMetricsStrip
                        timing={state.timing || activeMsg?.timing || null}
                        metrics={state.metrics || activeMsg?.metrics || null}
                      />
                    </div>
                  </div>
                  <div>
                    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-subtle)]">
                      Top documents
                    </h3>
                    <p className="mt-0.5 mb-2 text-[11px] leading-relaxed text-[var(--fg-subtle)]">
                      Click a row for full source text and ranking breakdown.
                    </p>
                    <DocumentResultsList
                      documents={state.documents}
                      retrievalMode={state.metrics?.retrievalMode}
                      activeId={selectedDoc?.documentId}
                      onSelect={(doc) => {
                        setSelectedDoc(doc);
                        setDrawerOpen(true);
                      }}
                    />
                  </div>
                </div>
              )}
              {rightTab === "process" && (
                <div id="inspector-panel-process" role="tabpanel" className="space-y-4">
                  <PipelineInspector
                    variant="notebook"
                    runStatus={state.status}
                    steps={state.steps}
                    timing={state.timing}
                    metrics={state.metrics}
                    results={state.results}
                    logs={state.logs}
                    chunkCount={retrievalUnitCount}
                    sourceCount={selectedCorpusCount}
                  />
                  <ProcessExplainPanel
                    timing={state.timing}
                    metrics={state.metrics}
                    documents={state.documents}
                    rankedChunks={
                      state.rankedChunks.length
                        ? state.rankedChunks
                        : state.results
                    }
                    packedChunks={state.results}
                    onSelectDocument={(doc) => {
                      setSelectedDoc(doc);
                      setDrawerOpen(true);
                    }}
                  />
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

      {selectedDoc && (
        <DocumentDetailDrawer
          notebookId={notebookId}
          document={selectedDoc}
          rankedChunks={
            state.rankedChunks.length ? state.rankedChunks : state.results
          }
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
        />
      )}

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="Delete this dataset?"
        description="Sources, chat history, and retrieval data for this workspace will be permanently removed."
        resourceLabel={pendingDelete?.title}
        confirmLabel="Delete dataset"
        cancelLabel="Keep dataset"
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => {
          if (!deleting) setPendingDelete(null);
        }}
      />
    </AppShell>
  );
}
