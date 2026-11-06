/**
 * Unit tests for the agent tool (lib/agent.ts): the deterministic fallback
 * summary and the pre-sign explainer text. Gemini itself is not called here
 * (it needs a live key and is flaky under load); the live behaviour is
 * covered by the manual DevNet checklist in the README.
 */
import { describe, expect, it } from "vitest";
import { buildExplainerText, deterministicSummary, summarize } from "./agent";

describe("deterministicSummary (fallback tool)", () => {
  it("returns short text unchanged", () => {
    const text = "Solana is fast. Fees are low.";
    expect(deterministicSummary(text)).toBe(text);
  });

  it("returns an empty string for empty input", () => {
    expect(deterministicSummary("")).toBe("");
    expect(deterministicSummary("   ")).toBe("");
  });

  it("extracts at most 3 sentences from long text, in original order", () => {
    const text =
      "Cats sleep all day. " +
      "The quick brown fox jumps over the lazy dog near the river bank. " +
      "Quantum computers use qubits to perform calculations. " +
      "The quick brown fox is a famous pangram used in typing practice. " +
      "Rain falls from clouds when water vapor condenses. " +
      "The quick brown fox appears in many textbooks about typing.";
    const summary = deterministicSummary(text);
    const sentences = summary.split(/(?<=[.!?])\s+/).filter(Boolean);
    expect(sentences.length).toBeLessThanOrEqual(3);
    // Sentences keep their original relative order.
    const indexes = sentences.map((s) => text.indexOf(s));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });

  it("does not invent content — every summary sentence comes from the input", () => {
    const text =
      "PayPerPrompt charges 0.01 SOL per call. The session limit is 0.5 SOL. " +
      "Payments run on Solana DevNet. The agent wallet receives the payment. " +
      "A plain-English explainer is shown before signing. " +
      "The meter drops by 0.01 SOL after each call.";
    const summary = deterministicSummary(text);
    for (const sentence of summary.split(/(?<=[.!?])\s+/).filter(Boolean)) {
      expect(text).toContain(sentence.trim());
    }
  });
});

describe("summarize orchestrator (no live key)", () => {
  it("returns a labeled deterministic fallback when no Gemini key is set", async () => {
    const prev = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const text =
        "PayPerPrompt charges 0.01 SOL per call. The session limit is 0.5 SOL. " +
        "Payments run on Solana DevNet. The agent wallet receives the payment. " +
        "A plain-English explainer is shown before signing. " +
        "The meter drops by 0.01 SOL after each call.";
      const result = await summarize(text);
      expect(result.source).toBe("fallback");
      expect(result.summary.length).toBeGreaterThan(0);
      expect(result.fallbackReason).toContain("No Gemini API key");
      // Fallback output is extracted from the input, never invented.
      for (const sentence of result.summary
        .split(/(?<=[.!?])\s+/)
        .filter(Boolean)) {
        expect(text).toContain(sentence.trim());
      }
    } finally {
      if (prev !== undefined) process.env.GEMINI_API_KEY = prev;
    }
  });
});

describe("buildExplainerText (pre-sign explainer)", () => {
  it("states the cost, the action, and the remaining limit", () => {
    const text = buildExplainerText({
      toolName: "Summarize",
      costSol: 0.01,
      remainingBeforeSol: 0.5,
      limitSol: 0.5,
    });
    expect(text).toContain("0.01 SOL");
    expect(text).toContain("Summarize");
    expect(text).toContain("0.49 SOL");
    expect(text).toContain("0.50 SOL");
    expect(text).toContain("Nothing else will be charged.");
  });

  it("never reports negative remaining", () => {
    const text = buildExplainerText({
      toolName: "Summarize",
      costSol: 0.01,
      remainingBeforeSol: 0.01,
      limitSol: 0.5,
    });
    expect(text).toContain("0.00 SOL");
    expect(text).not.toContain("-0.01");
  });
});
