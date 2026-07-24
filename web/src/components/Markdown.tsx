"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export const Markdown = memo(function Markdown({ content }: { content: string }) {
  if (!content) return null;
  return (
    <div className="prose prose-sm max-w-none prose-a:text-[var(--accent)] prose-strong:text-[var(--fg)]">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
});
