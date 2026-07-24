import { afterEach, describe, expect, it } from "vitest";
import { evaluateRAG } from "./evaluator";
import type { RankedChunk } from "@/lib/ir/types";

const originalKey = process.env.LLM_API_KEY;

function context(): RankedChunk[] {
  return [
    {
      chunkId: "c1",
      documentId: "d1",
      title: "Vitamin study",
      text: "The study involved 14,641 physicians.",
      chunkIndex: 0,
      bm25Score: 1,
      bm25Rank: 1,
      finalScore: 1,
      finalRank: 1,
      citationId: 1,
    },
  ];
}

describe("evaluateRAG", () => {
  afterEach(() => {
    if (originalKey == null) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = originalKey;
  });

  it("returns explicitly labeled heuristic fallback when LLM is unavailable", async () => {
    process.env.LLM_API_KEY = "";
    const result = await evaluateRAG({
      query: "How many physicians were studied?",
      context: context(),
      answer: "The study involved 14,641 physicians [1].",
    });

    expect(result.evaluationMethod).toBe("heuristic_fallback");
    expect(result.evaluationWarning).toMatch(/heuristic fallback/i);
    expect(result.faithfulness).toBeGreaterThanOrEqual(0);
    expect(result.faithfulness).toBeLessThanOrEqual(1);
    expect(result.answerRelevancy).toBeGreaterThanOrEqual(0);
    expect(result.answerRelevancy).toBeLessThanOrEqual(1);
    expect(result.contextRelevancy).toBeGreaterThanOrEqual(0);
    expect(result.contextRelevancy).toBeLessThanOrEqual(1);
  });

  it("evaluates an empty context without throwing", async () => {
    process.env.LLM_API_KEY = "";
    const result = await evaluateRAG({
      query: "What was studied?",
      context: [],
      answer: "No evidence was retrieved.",
    });

    expect(result.evaluationMethod).toBe("heuristic_fallback");
    expect(result.contextRelevancyReason).toMatch(/empty|available/i);
  });
});
