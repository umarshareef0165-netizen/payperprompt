/**
 * Tests for the durable spend store (lib/db.ts).
 *
 * The store contract is tested against the in-memory fake
 * (lib/test-store.ts) — no real DB needed. The Neon implementation is
 * thin SQL over the same interface (claim = INSERT + PRIMARY KEY,
 * charge = upsert + RETURNING), so the contract tests cover the
 * behavior the routes depend on: atomic claims, release-on-failure,
 * per-payer spend, and reset semantics.
 * Run with: npm test
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { PRICE_PER_CALL_LAMPORTS, canAffordCall } from "./pricing";
import { createNeonStore, setSpendStore } from "./db";
import { createMemoryStore } from "./test-store";

describe("spend store contract (in-memory fake)", () => {
  let store: ReturnType<typeof createMemoryStore>;

  beforeEach(() => {
    store = createMemoryStore();
    setSpendStore(store);
  });

  it("tracks spend separately per payer", async () => {
    await store.recordSpend("Alice");
    await store.recordSpend("Alice");
    await store.recordSpend("Bob");
    expect(await store.getSpentLamports("Alice")).toBe(
      2 * PRICE_PER_CALL_LAMPORTS,
    );
    expect(await store.getSpentLamports("Bob")).toBe(PRICE_PER_CALL_LAMPORTS);
    expect(await store.getSpentLamports("Carol")).toBe(0);
  });

  it("reports remaining per payer and blocks at the limit", async () => {
    const payer = "Dave";
    for (let i = 0; i < 50; i++) await store.recordSpend(payer);
    expect(await store.getRemainingLamports(payer)).toBe(0);
    expect(canAffordCall(await store.getSpentLamports(payer))).toBe(false);
  });

  it("resetSession clears one payer or all spend, never signatures", async () => {
    await store.recordSpend("Alice");
    await store.recordSpend("Bob");
    expect(await store.claimSignature("sig-keep-1", "Alice")).toBe(true);

    await store.resetSession("Alice");
    expect(await store.getSpentLamports("Alice")).toBe(0);
    expect(await store.getSpentLamports("Bob")).toBe(PRICE_PER_CALL_LAMPORTS);
    // The signature survives a spend reset — a paid call stays paid.
    expect(await store.isSignatureUsed("sig-keep-1")).toBe(true);

    await store.resetSession();
    expect(await store.getSpentLamports("Bob")).toBe(0);
  });

  it("claim is atomic: second claim of the same signature fails", async () => {
    expect(await store.claimSignature("sig-once-1", "Alice")).toBe(true);
    expect(await store.isSignatureUsed("sig-once-1")).toBe(true);
    expect(await store.claimSignature("sig-once-1", "Alice")).toBe(false);
  });

  it("release frees the signature so the payment can be retried", async () => {
    expect(await store.claimSignature("sig-retry-1", "Alice")).toBe(true);
    await store.releaseSignature("sig-retry-1");
    expect(await store.isSignatureUsed("sig-retry-1")).toBe(false);
    expect(await store.claimSignature("sig-retry-1", "Alice")).toBe(true);
  });
});

describe("Neon store configuration", () => {
  const savedUrl = process.env.DATABASE_URL;

  afterEach(() => {
    if (savedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedUrl;
    vi.unstubAllEnvs();
  });

  it("refuses to run without DATABASE_URL (clear error, no silent fallback)", async () => {
    delete process.env.DATABASE_URL;
    const neonStore = createNeonStore();
    await expect(neonStore.getSpentLamports("Alice")).rejects.toThrow(
      /DATABASE_URL is not set/,
    );
  });
});
