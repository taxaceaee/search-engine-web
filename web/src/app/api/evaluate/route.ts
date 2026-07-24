import { NextRequest } from "next/server";
import { z } from "zod";
import { getSessionClaimsFromRequest } from "@/lib/auth";
import { evaluateRAG } from "@/lib/llm/evaluator";
import { updateSearchMessageMetrics } from "@/lib/db/sessions-repo";
import { updateNotebookMessageMetrics } from "@/lib/db/notebook-messages-repo";
import { elapsed, nowMs } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const evaluationChunkSchema = z.object({
  chunkId: z.string().min(1).max(200),
  documentId: z.string().min(1).max(200),
  title: z.string().max(1000),
  text: z.string().max(16000),
  chunkIndex: z.number().int().nonnegative(),
  bm25Score: z.number().finite(),
  bm25Rank: z.number().int().nonnegative(),
  finalRank: z.number().int().nonnegative(),
  citationId: z.number().int().positive(),
  denseScore: z.number().finite().optional().nullable().transform((value) => value ?? undefined),
  denseRank: z.number().int().nonnegative().optional().nullable().transform((value) => value ?? undefined),
  finalScore: z.number().finite().optional().nullable().transform((value) => value ?? undefined),
});

const bodySchema = z.object({
  messageId: z.string().min(1).max(200).optional(),
  messageType: z.enum(["search", "notebook"]).optional(),
  query: z.string().trim().min(1).max(4000),
  context: z.array(evaluationChunkSchema).max(12),
  answer: z.string().trim().min(1).max(30000),
});

export async function POST(req: NextRequest) {
  const claims = getSessionClaimsFromRequest(req);
  if (!claims) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid evaluation request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const { messageId, messageType, query, context, answer } = parsed.data;

    const start = nowMs();
    const metrics = await evaluateRAG({ query, context, answer });
    const evaluationMs = elapsed(start);
    metrics.evaluationMs = evaluationMs;
    let persistenceMs = 0;

    // Save metrics if messageId and messageType are provided
    if (messageId && messageType) {
      const persistStart = nowMs();
      if (messageType === "search") {
        const saved = await updateSearchMessageMetrics(messageId, metrics);
        if (!saved) {
          return Response.json({ error: "Evaluation message not found" }, { status: 404 });
        }
      } else if (messageType === "notebook") {
        const saved = await updateNotebookMessageMetrics(messageId, metrics);
        if (!saved) {
          return Response.json({ error: "Evaluation message not found" }, { status: 404 });
        }
      }
      persistenceMs = elapsed(persistStart);
    }

    return Response.json({ metrics, evaluationMs, persistenceMs });
  } catch (error) {
    console.error("Evaluation API error:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Evaluation failed" },
      { status: 500 }
    );
  }
}
