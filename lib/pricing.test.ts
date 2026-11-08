/**
 * Unit tests for pricing + session-limit logic (lib/pricing.ts).
 * Run with: npm test
 */
import { describe, expect, it } from "vitest";
import {
  PRICE_PER_CALL_SOL,
  PRICE_PER_CALL_LAMPORTS,
  DEFAULT_SESSION_LIMIT_SOL,
  DEFAULT_SESSION_LIMIT_LAMPORTS,
  LAMPORTS_PER_SOL,
  lamportsToSol,
  solToLamports,
  remainingLamports,
  canAffordCall,
  applySpend,
  meterPercent,
  formatSol,
} from "./pricing";

describe("locked pricing constants", () => {
  it("charges exactly 0.01 SOL per tool call", () => {
    expect(PRICE_PER_CALL_SOL).toBe(0.01);
    expect(PRICE_PER_CALL_LAMPORTS).toBe(10_000_000);
  });

  it("defaults the session limit to 0.5 SOL", () => {
    expect(DEFAULT_SESSION_LIMIT_SOL).toBe(0.5);
    expect(DEFAULT_SESSION_LIMIT_LAMPORTS).toBe(500_000_000);
  });

  it("converts between SOL and lamports", () => {
    expect(lamportsToSol(PRICE_PER_CALL_LAMPORTS)).toBe(0.01);
    expect(solToLamports(0.5)).toBe(500_000_000);
    expect(LAMPORTS_PER_SOL).toBe(1_000_000_000);
  });
});

describe("remaining + affordability", () => {
  it("starts with the full limit remaining", () => {
    expect(remainingLamports(0)).toBe(DEFAULT_SESSION_LIMIT_LAMPORTS);
  });

  it("drops by exactly one price per call", () => {
    expect(remainingLamports(PRICE_PER_CALL_LAMPORTS)).toBe(
      DEFAULT_SESSION_LIMIT_LAMPORTS - PRICE_PER_CALL_LAMPORTS,
    );
    // 49 calls spent -> exactly one call left
    expect(remainingLamports(49 * PRICE_PER_CALL_LAMPORTS)).toBe(
      PRICE_PER_CALL_LAMPORTS,
    );
  });

  it("blocks at 0: no remaining once the limit is spent", () => {
    expect(
      remainingLamports(DEFAULT_SESSION_LIMIT_LAMPORTS),
    ).toBe(0);
    expect(canAffordCall(DEFAULT_SESSION_LIMIT_LAMPORTS)).toBe(false);
  });

  it("never reports negative remaining (clamps at 0)", () => {
    expect(remainingLamports(DEFAULT_SESSION_LIMIT_LAMPORTS + 1)).toBe(0);
    expect(remainingLamports(999_999_999_999)).toBe(0);
  });

  it("canAffordCall is true until the last 0.01 SOL", () => {
    expect(canAffordCall(0)).toBe(true);
    expect(canAffordCall(49 * PRICE_PER_CALL_LAMPORTS)).toBe(true);
    expect(canAffordCall(50 * PRICE_PER_CALL_LAMPORTS)).toBe(false);
  });

  it("applySpend accumulates spend", () => {
    expect(applySpend(0)).toBe(PRICE_PER_CALL_LAMPORTS);
    expect(applySpend(PRICE_PER_CALL_LAMPORTS)).toBe(
      2 * PRICE_PER_CALL_LAMPORTS,
    );
  });
});

describe("meter math", () => {
  it("is 100% full at the start and 0% when empty", () => {
    expect(meterPercent(DEFAULT_SESSION_LIMIT_LAMPORTS)).toBe(100);
    expect(meterPercent(0)).toBe(0);
  });

  it("is 50% after half the limit is spent", () => {
    expect(
      meterPercent(DEFAULT_SESSION_LIMIT_LAMPORTS / 2),
    ).toBe(50);
  });

  it("clamps to 0–100", () => {
    expect(meterPercent(-5)).toBe(0);
    expect(meterPercent(DEFAULT_SESSION_LIMIT_LAMPORTS * 2)).toBe(100);
  });

  it("formats SOL with two decimals", () => {
    expect(formatSol(PRICE_PER_CALL_LAMPORTS)).toBe("0.01 SOL");
    expect(formatSol(DEFAULT_SESSION_LIMIT_LAMPORTS)).toBe("0.50 SOL");
  });
});
