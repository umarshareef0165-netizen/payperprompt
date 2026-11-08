/**
 * In-memory fake of the SpendStore interface (lib/db.ts) — TESTS ONLY.
 *
 * It mirrors the Neon store's contract exactly, including the atomic
 * claim: claimSignature returns false when the signature is already
 * claimed. It is never imported by a route handler and never the source
 * of truth in production; it exists so the route tests run with no DB.
 *
 * `failNextClaim` forces the next claimSignature call to return false
 * (signature NOT recorded) so tests can simulate a concurrent replay
 * that wins the race after verification but before our claim.
 */
import {
  DEFAULT_SESSION_LIMIT_LAMPORTS,
  PRICE_PER_CALL_LAMPORTS,
  remainingLamports,
} from "./pricing";
import type { SpendStore } from "./db";

export function createMemoryStore(): SpendStore & {
  /** Force the next claimSignature call to fail (return false). */
  failNextClaim(): void;
} {
  const used = new Set<string>();
  const spentByPayer = new Map<string, number>();
  let failNext = false;

  return {
    failNextClaim() {
      failNext = true;
    },

    async isSignatureUsed(signature) {
      return used.has(signature);
    },

    async claimSignature(signature) {
      if (failNext) {
        failNext = false;
        return false;
      }
      if (used.has(signature)) return false;
      used.add(signature);
      return true;
    },

    async releaseSignature(signature) {
      used.delete(signature);
    },

    async getSpentLamports(payer) {
      return spentByPayer.get(payer) ?? 0;
    },

    async recordSpend(payer, amountLamports = PRICE_PER_CALL_LAMPORTS) {
      const next = (spentByPayer.get(payer) ?? 0) + amountLamports;
      spentByPayer.set(payer, next);
      return next;
    },

    async getRemainingLamports(
      payer,
      limitLamports = DEFAULT_SESSION_LIMIT_LAMPORTS,
    ) {
      return remainingLamports(
        spentByPayer.get(payer) ?? 0,
        limitLamports,
      );
    },

    async resetSession(payer) {
      if (payer) {
        spentByPayer.delete(payer);
      } else {
        spentByPayer.clear();
      }
    },
  };
}
