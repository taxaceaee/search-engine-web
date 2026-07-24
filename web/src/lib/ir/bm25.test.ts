import { afterEach, describe, expect, it, vi } from "vitest";
import { bm25Retrieve, tokenize } from "./bm25";
import { chunkDocument } from "./chunker";
import { packContext } from "./packer";
import { retrieveEvidence } from "./adaptive-rrf";

describe("tokenize", () => {
  it("lowercases and splits", () => {
    expect(tokenize("Hello, World!")).toEqual(["hello", "world"]);
  });
});

describe("bm25Retrieve", () => {
  it("ranks relevant chunk higher", () => {
    const chunks = [
      {
        chunkId: "1",
        documentId: "a",
        title: "A",
        text: "cats and dogs are animals",
        chunkIndex: 0,
      },
      {
        chunkId: "2",
        documentId: "b",
        title: "B",
        text: "quantum computing uses qubits and superposition",
        chunkIndex: 0,
      },
    ];
    const ranked = bm25Retrieve("quantum qubits", chunks, 2);
    expect(ranked[0].chunkId).toBe("2");
    expect(ranked[0].citationId).toBe(1);
  });
});

describe("chunk + pack", () => {
  it("chunks long text and packs with diversity", () => {
    const words = Array.from({ length: 800 }, (_, i) => `word${i % 50}`).join(" ");
    const chunks = chunkDocument({
      documentId: "d1",
      title: "Doc",
      url: "https://example.com/a",
      text: words,
    });
    expect(chunks.length).toBeGreaterThan(1);

    const fakeRanked = chunks.slice(0, 10).map((c, i) => ({
      ...c,
      bm25Score: 10 - i,
      bm25Rank: i + 1,
      finalRank: i + 1,
      citationId: i + 1,
    }));
    const packed = packContext(fakeRanked, 4, 2);
    expect(packed.length).toBeLessThanOrEqual(4);
    expect(packed[0].citationId).toBe(1);
  });
});

describe("retrieveEvidence", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("falls back to BM25 when adaptive retrieval has no embedding provider", async () => {
    delete process.env.EMBEDDING_API_URL;
    delete process.env.EMBEDDING_API_KEY;
    process.env.RETRIEVAL_MODE = "adaptive_rrf";

    const chunks = [
      {
        chunkId: "1",
        documentId: "a",
        title: "A",
        text: "quantum qubits superposition",
        chunkIndex: 0,
      },
    ];

    const result = await retrieveEvidence("quantum", chunks, 1, "adaptive_rrf");
    expect(result.diagnostics.mode).toBe("bm25_fallback");
    expect(result.results[0].chunkId).toBe("1");
    expect(result.results[0].finalScore).toBe(result.results[0].bm25Score);
  });

  it("fuses BM25 and dense ranks with adaptive RRF", async () => {
    process.env.RETRIEVAL_MODE = "adaptive_rrf";
    process.env.EMBEDDING_PROVIDER = "tei";
    process.env.EMBEDDING_API_URL = "http://embedding.local/embed";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          embeddings: [
            [1, 0],
            [0.1, 0.9],
            [0.9, 0.1],
          ],
        }),
      })) as unknown as typeof fetch,
    );

    const chunks = [
      {
        chunkId: "bm25",
        documentId: "a",
        title: "A",
        text: "alpha alpha lexical",
        chunkIndex: 0,
      },
      {
        chunkId: "dense",
        documentId: "b",
        title: "B",
        text: "semantic related concept",
        chunkIndex: 0,
      },
    ];

    const result = await retrieveEvidence("alpha", chunks, 2, "adaptive_rrf");
    expect(result.diagnostics.mode).toBe("adaptive_rrf");
    expect(result.diagnostics.denseUsed).toBe(true);
    expect(result.results.map((r) => r.chunkId)).toContain("dense");
    expect(result.results[0].retrievalMode).toBe("adaptive_rrf");
  });
});
