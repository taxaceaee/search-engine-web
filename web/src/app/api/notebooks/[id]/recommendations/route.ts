import { requireUserId } from "@/lib/auth";
import { loadChunks } from "@/lib/db/notebooks-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "for", "from", "how", "in", "is", "of",
  "on", "the", "to", "what", "with",
]);

function normalize(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function countOccurrences(haystack: string, needle: string) {
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  while ((cursor = haystack.indexOf(needle, cursor)) !== -1) {
    count += 1;
    cursor += needle.length;
    if (count >= 8) break;
  }
  return count;
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = requireUserId(req);
  if ("error" in auth) return auth.error;

  const { id } = await ctx.params;
  const query = new URL(req.url).searchParams.get("q")?.trim() || "";
  if (query.length < 2) return Response.json({ suggestions: [] });

  try {
    const terms = normalize(query)
      .split(/\s+/)
      .filter((term) => term.length >= 2 && !STOP_WORDS.has(term));
    if (!terms.length) return Response.json({ suggestions: [] });

    // Reuse the same retrieval cache, but ask Postgres for a small lexical
    // candidate set first. Suggestions only need matching source text; they
    // should not download an entire PDF corpus on every debounced keystroke.
    // loadChunks keeps the full-corpus compatibility fallback when the FTS
    // migration is not present.
    const chunks = await loadChunks(id, undefined, {
      includeEmbeddings: false,
      searchQuery: query,
      searchCandidateLimit: 64,
      searchMinCandidates: 1,
    });
    const bySource = new Map<string, { title: string; text: string }>();
    for (const chunk of chunks) {
      const sourceId = chunk.documentId.split("#")[0];
      const existing = bySource.get(sourceId);
      bySource.set(sourceId, {
        title: existing?.title || chunk.title,
        text: existing ? `${existing.text}\n${chunk.text}` : chunk.text,
      });
    }
    const matches = [...bySource.entries()]
      .map(([id, source]) => {
        const title = normalize(source.title);
        const text = normalize(source.text);
        const titleHits = terms.reduce((sum, term) => sum + countOccurrences(title, term), 0);
        const contentHits = terms.reduce((sum, term) => sum + countOccurrences(text, term), 0);
        return { source: { id, ...source }, score: titleHits * 12 + Math.min(contentHits, 12) };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.source.title.localeCompare(b.source.title))
      .slice(0, 5);

    const suggestions = matches.flatMap(({ source }) => [
      `Summarize ${source.title.trim()}`,
      `Find ${query} in ${source.title.trim()}`,
    ]);
    return Response.json({ suggestions: suggestions.slice(0, 5) });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Recommendation search failed" },
      { status: 500 },
    );
  }
}
