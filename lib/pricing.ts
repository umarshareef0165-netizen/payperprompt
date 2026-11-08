/**
 * Pricing + session spending-limit math for PayPerPrompt.
 *
 * Locked numbers (MLH Solana Hackathon, AI track):
 * - Price per tool call: 0.01 SOL
 * - Default session spending limit: 0.5 SOL
 *
 * All money math is done in lamports (integers) so the meter is exact.
 *
 * This file is PURE functions + constants only. The stateful store
 * (which signatures are used, how much a payer has spent) lives in
 * lib/db.ts backed by Neon Postgres — the old in-memory Map here was
 * per-instance only, so a meter read on another Vercel instance saw
 * stale spend (live re-verification: meter went 0.02 -> 0.01).
 */

export const PRICE_PER_CALL_SOL = 0.01;
export const DEFAULT_SESSION_LIMIT_SOL = 0.5;
export const LAMPORTS_PER_SOL = 1_000_000_000;

export const PRICE_PER_CALL_LAMPORTS = Math.round(
  PRICE_PER_CALL_SOL * LAMPORTS_PER_SOL,
); // 10,000,000
export const DEFAULT_SESSION_LIMIT_LAMPORTS = Math.round(
  DEFAULT_SESSION_LIMIT_SOL * LAMPORTS_PER_SOL,
); // 500,000,000

/** Lamports -> SOL as a number (e.g. 10_000_000 -> 0.01). */
export function lamportsToSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL;
}

/** SOL -> lamports as an integer. */
export function solToLamports(sol: number): number {
  return Math.round(sol * LAMPORTS_PER_SOL);
}

/** Remaining lamports in a session. Never goes below 0. */
export function remainingLamports(
  spentLamports: number,
  limitLamports: number = DEFAULT_SESSION_LIMIT_LAMPORTS,
): number {
  return Math.max(0, limitLamports - spentLamports);
}

/** True when the session can still afford one more tool call. */
export function canAffordCall(
  spentLamports: number,
  limitLamports: number = DEFAULT_SESSION_LIMIT_LAMPORTS,
): boolean {
  return (
    remainingLamports(spentLamports, limitLamports) >= PRICE_PER_CALL_LAMPORTS
  );
}

/** New spent total after paying for one call. */
export function applySpend(
  spentLamports: number,
  amountLamports: number = PRICE_PER_CALL_LAMPORTS,
): number {
  return spentLamports + amountLamports;
}

/** Meter fill percentage (0–100) for a remaining/limit pair. */
export function meterPercent(
  remaining: number,
  limit: number = DEFAULT_SESSION_LIMIT_LAMPORTS,
): number {
  if (limit <= 0) return 0;
  return Math.min(100, Math.max(0, (remaining / limit) * 100));
}

/** Format lamports as a SOL string with 2 decimals (e.g. "0.49 SOL"). */
export function formatSol(lamports: number): string {
  return `${lamportsToSol(lamports).toFixed(2)} SOL`;
}
