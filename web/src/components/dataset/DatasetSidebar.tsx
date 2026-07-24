"use client";

import { memo, useMemo, useState } from "react";
import Link from "next/link";
import {
  BookOpen,
  Check,
  FolderPlus,
  Loader2,
  Lock,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { isProtectedDatasetTitle } from "@/lib/protected-datasets";
import { Logo } from "@/components/Logo";
import { UserMenu } from "@/components/UserMenu";

export type DatasetSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt?: string;
  locked?: boolean;
};

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export const DatasetSidebar = memo(function DatasetSidebar({
  items,
  currentId,
  checkedIds,
  loading,
  onNew,
  onSelect,
  onToggleCheck,
  onRename,
  onDelete,
  onCollapse,
  className,
}: {
  items: DatasetSummary[];
  /** Open workspace (route id) for upload/history UI */
  currentId: string | null;
  /** Datasets included in retrieval (checkbox multi-select) */
  checkedIds: string[];
  loading?: boolean;
  onNew: () => void;
  onSelect: (id: string) => void;
  onToggleCheck: (id: string, checked: boolean) => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string, title: string) => void;
  onCollapse?: () => void;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((n) => n.title.toLowerCase().includes(q));
  }, [items, query]);

  const checkedCount = checkedIds.length;

  const startEdit = (n: DatasetSummary) => {
    setEditingId(n.id);
    setEditTitle(n.title);
  };

  const saveEdit = async () => {
    if (!editingId || !editTitle.trim()) return;
    setBusyId(editingId);
    try {
      await onRename(editingId, editTitle.trim());
      setEditingId(null);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <aside className={cn("chat-sidebar", className)} aria-label="Datasets">
      {/* Keeps the shared chat-sidebar-header-row contract while using the denser library header. */}
      <div className="chat-sidebar-header dataset-sidebar-header">
        <div className="dataset-sidebar-brand-row">
          <Link href="/" className="chat-sidebar-brand" aria-label="SearchEngine home">
            <Logo className="h-7 w-7" showWordmark />
          </Link>
          <div className="dataset-sidebar-title-block">
            <div className="chat-sidebar-heading truncate">Datasets</div>
            <span>{items.length} workspace{items.length === 1 ? "" : "s"}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={onNew}
              className="btn-primary !min-h-9 !gap-1.5 !rounded-lg !px-2.5 !text-xs !shadow-sm"
              title="Create a new dataset"
              aria-label="New dataset"
            >
              <Plus className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">New</span>
            </button>
            {onCollapse && (
              <button
                type="button"
                onClick={onCollapse}
                className="hidden h-9 w-9 items-center justify-center rounded-lg text-[var(--fg-muted)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--fg)] xl:inline-flex"
                aria-label="Collapse datasets panel"
                title="Collapse"
              >
                <PanelLeftClose className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {items.length > 0 && (
        <div className="dataset-sidebar-tools shrink-0 border-b border-[var(--border)] px-3 py-2.5">
          <label className="relative block">
            <span className="sr-only">Filter datasets</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--fg-subtle)]" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a dataset…"
              className="field !min-h-10 !pl-9 !pr-3 !text-sm"
              autoComplete="off"
            />
          </label>
          <div className="dataset-sidebar-selection" aria-live="polite">
            <span><strong>{checkedCount}</strong> selected for retrieval</span>
            <span>{items.length} total</span>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
        {loading && !items.length ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-[var(--fg-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : !items.length ? (
          <div className="mx-1 mt-3 rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--bg-panel)] px-3 py-8 text-center">
            <FolderPlus className="mx-auto h-7 w-7 text-[var(--accent)]" />
            <p className="mt-2 text-sm font-semibold text-[var(--fg)]">
              No datasets yet
            </p>
            <p className="mt-1 text-ui-xs leading-relaxed text-[var(--fg-muted)]">
              Create a workspace, store raw sources, then chat with retrieval
              and process lab tools.
            </p>
            <button
              type="button"
              onClick={onNew}
              className="btn-secondary mt-3 !min-h-9 !text-sm"
            >
              <Plus className="h-4 w-4" />
              New dataset
            </button>
          </div>
        ) : !filtered.length ? (
          <p className="px-2 py-8 text-center text-sm text-[var(--fg-muted)]">
            No datasets match “{query.trim()}”
          </p>
        ) : (
          <>
            <div className="dataset-sidebar-section-label">Your workspaces</div>
            <ul className="space-y-1" aria-label="Dataset list">
            {filtered.map((n) => {
              const active = n.id === currentId;
              const checked = checkedIds.includes(n.id);
              const protectedDataset = Boolean(n.locked) || isProtectedDatasetTitle(n.title);
              const editing = editingId === n.id;
              return (
                <li key={n.id}>
                  <div
                    className={cn(
                      "chat-sidebar-item group",
                      active && "chat-sidebar-item--active",
                      checked && !active && "ring-1 ring-[var(--mood-border)]/60",
                    )}
                  >
                    <label
                      className="mt-1 flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center"
                      title={
                        checked
                          ? "Included in chat retrieval"
                          : "Include this dataset in chat"
                      }
                    >
                      <span className="sr-only">
                        Use dataset {n.title} for retrieval
                      </span>
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-[var(--border-strong)] text-[var(--accent)] focus:ring-[var(--ring)]"
                        checked={checked}
                        onChange={(e) => {
                          e.stopPropagation();
                          onToggleCheck(n.id, e.target.checked);
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </label>

                    {editing ? (
                      <div className="flex min-w-0 flex-1 items-center gap-1">
                        <input
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          className="field !min-h-9 flex-1 !px-2.5 !py-1 !text-sm"
                          autoFocus
                          aria-label="Dataset name"
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void saveEdit();
                            if (e.key === "Escape") setEditingId(null);
                          }}
                        />
                        <button
                          type="button"
                          className="rounded-md p-2 text-emerald-700 hover:bg-emerald-50"
                          onClick={() => void saveEdit()}
                          disabled={busyId === n.id}
                          aria-label="Save name"
                        >
                          <Check className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => onSelect(n.id)}
                          className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 text-left"
                          aria-current={active ? "true" : undefined}
                        >
                          <span
                            className={cn(
                              "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                              active
                                ? "bg-[var(--accent)] text-white shadow-sm"
                                : "bg-[var(--bg-panel)] text-[var(--fg-muted)] ring-1 ring-[var(--border)]",
                            )}
                            aria-hidden
                          >
                            <BookOpen className="h-4 w-4" />
                          </span>
                          <span className="min-w-0">
                            <span className="chat-sidebar-item-title">
                              {n.title}
                            </span>
                            <span className="chat-sidebar-item-meta">
                              {active ? (
                                <span className="mr-1.5 inline-flex items-center rounded-md bg-[var(--mood-soft)] px-1.5 py-px text-[11px] font-semibold uppercase tracking-wide text-[var(--mood)] ring-1 ring-[var(--mood-border)]">
                                  Open
                                </span>
                              ) : null}
                              {checked ? (
                                <span className="mr-1.5 inline-flex items-center rounded-md bg-[var(--teal-soft)] px-1.5 py-px text-[11px] font-semibold uppercase tracking-wide text-[var(--teal)] ring-1 ring-[var(--teal-border)]">
                                  In use
                                </span>
                              ) : null}
                              {protectedDataset ? (
                                <span
                                  className="mr-1.5 inline-flex items-center gap-1 rounded-md bg-[var(--surface)] px-1.5 py-px text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-subtle)] ring-1 ring-[var(--border)]"
                                  title="Protected dataset — cannot be deleted"
                                >
                                  <Lock className="h-3 w-3" aria-hidden="true" />
                                  Protected
                                </span>
                              ) : null}
                              {relativeTime(n.updatedAt || n.createdAt)}
                            </span>
                          </span>
                        </button>
                        <div className="flex shrink-0 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                          <button
                            type="button"
                            className="rounded-lg p-2 text-[var(--fg-subtle)] hover:bg-[var(--surface)] hover:text-[var(--fg)]"
                            onClick={(e) => {
                              e.stopPropagation();
                              startEdit(n);
                            }}
                            aria-label={`Rename ${n.title}`}
                            title="Rename"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          {protectedDataset ? (
                            <button
                              type="button"
                              disabled
                              aria-label={`${n.title} is protected and cannot be deleted`}
                              title="Protected dataset — cannot be deleted"
                              className="cursor-not-allowed rounded-lg p-2 text-[var(--fg-subtle)] opacity-70"
                            >
                              <Lock className="h-4 w-4" aria-hidden="true" />
                            </button>
                          ) : (
                            <button
                              type="button"
                              aria-label={`Delete ${n.title}`}
                              title="Delete dataset"
                              onClick={(e) => {
                                e.stopPropagation();
                                onDelete(n.id, n.title);
                              }}
                              className="rounded-lg p-2 text-[var(--fg-subtle)] hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
            </ul>
          </>
        )}
      </div>
      <div className="chat-sidebar-account">
        <UserMenu variant="sidebar" />
      </div>
    </aside>
  );
});
