/**
 * Durable replay protection + spend meter (Neon Postgres).
 *
 * This is the SINGLE source of truth for:
 * - which payment signatures have already bought a summary, and
 * - how many lamports each payer wallet has been charged.
 *
 * The old in-memory Set/Map lived in one serverless function instance's
 * memory, so a replayed signature or a meter read landing on a different
 * Vercel instance was not caught (live re-verification: meter went
 * 0.02 -> 0.01 and a replay returned 200 with a fresh summary).
 * Every read/write here goes through Neon, so all instances agree.
 *
 * Driver: @neondatabase/serverless (HTTP driver — no persistent
 * connections, which is what serverless needs). DATABASE_URL comes from
 * the environment (Vercel env var on the PayPerPrompt project); it is
 * never hardcoded and never written into any file. The client is created
 * lazily on first use, so importing this module never touches the DB —
 * tests run with an injected in-memory store instead (see setSpendStore).
 */

import { neon } from "@neondatabase/serverless";
import {
  DEFAULT_SESSION_LIMIT_LAMPORTS,
  PRICE_PER_CALL_LAMPORTS,
  remainingLamports,
} from "./pricing";

export interface SpendStore {
  /** True when this signature has already bought a summary. */
  isSignatureUsed(signature: string): Promise<boolean>;
  /**
   * Atomically claim a signature. Returns true on success, false when
   * the signature is already claimed (concurrent replay loses the race).
   * Only throws on a real DB failure — never on a replay.
   */
  claimSignature(signature: string, payer: string): Promise<boolean>;
  /** Release a claim (tool failed) so the same payment can be retried. */
  releaseSignature(signature: string): Promise<void>;
  /** Lamports charged to a payer so far (0 when the payer is new). */
  getSpentLamports(payer: string): Promise<number>;
  /** Charge one call; returns the new spent total. */
  recordSpend(
    payer: string,
    amountLamports?: number,
  ): Promise<number>;
  /** Remaining lamports in the session. Never below 0. */
  getRemainingLamports(
    payer: string,
    limitLamports?: number,
  ): Promise<number>;
  /** Clear one payer's spend (or all spend). Never touches signatures. */
  resetSession(payer?: string): Promise<void>;
}

type Sql = ReturnType<typeof neon>;

/** One result row (the driver returns BIGINT columns as strings). */
type Row = Record<string, unknown>;

let sqlClient: Sql | null = null;

function getSql(): Sql {
  if (!sqlClient) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL is not set. Set it to the pooled connection string " +
          "of the neon-aqua-queen project (Vercel env var on PayPerPrompt) " +
          "and run db/schema.sql in the Neon SQL Editor first.",
      );
    }
    sqlClient = neon(url);
  }
  return sqlClient;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

/** The Neon-backed store (the production default). */
export function createNeonStore(): SpendStore {
  return {
    async isSignatureUsed(signature) {
      const sql = getSql();
      const rows = (await sql`SELECT 1 FROM payperprompt_used_signatures
        WHERE signature = ${signature}`) as Row[];
      return rows.length > 0;
    },

    async claimSignature(signature, payer) {
      const sql = getSql();
      try {
        await sql`INSERT INTO payperprompt_used_signatures (signature, payer)
          VALUES (${signature}, ${payer})`;
        return true;
      } catch (error) {
        // PRIMARY KEY collision = this payment was already claimed
        // (possibly by a concurrent request on another instance).
        if (isUniqueViolation(error)) return false;
        throw error;
      }
    },

    async releaseSignature(signature) {
      const sql = getSql();
      await sql`DELETE FROM payperprompt_used_signatures
        WHERE signature = ${signature}`;
    },

    async getSpentLamports(payer) {
      const sql = getSql();
      const rows = (await sql`SELECT spent_lamports FROM payperprompt_spend
        WHERE payer = ${payer}`) as Row[];
      if (rows.length === 0) return 0;
      // BIGINT comes back as a string from Postgres — convert it.
      return Number(rows[0].spent_lamports);
    },

    async recordSpend(payer, amountLamports = PRICE_PER_CALL_LAMPORTS) {
      const sql = getSql();
      const rows = (await sql`
        INSERT INTO payperprompt_spend (payer, spent_lamports)
        VALUES (${payer}, ${amountLamports})
        ON CONFLICT (payer) DO UPDATE
          SET spent_lamports = payperprompt_spend.spent_lamports
            + EXCLUDED.spent_lamports
        RETURNING spent_lamports`) as Row[];
      return Number(rows[0].spent_lamports);
    },

    async getRemainingLamports(
      payer,
      limitLamports = DEFAULT_SESSION_LIMIT_LAMPORTS,
    ) {
      const spent = await this.getSpentLamports(payer);
      return remainingLamports(spent, limitLamports);
    },

    async resetSession(payer) {
      const sql = getSql();
      if (payer) {
        await sql`DELETE FROM payperprompt_spend WHERE payer = ${payer}`;
      } else {
        await sql`DELETE FROM payperprompt_spend`;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Active store. Production uses the Neon store; tests swap in an
// in-memory fake with setSpendStore (never used by a route handler).
// ---------------------------------------------------------------------------

let store: SpendStore = createNeonStore();

export function setSpendStore(next: SpendStore): void {
  store = next;
}

export function getSpendStore(): SpendStore {
  return store;
}

export function isSignatureUsed(signature: string): Promise<boolean> {
  return store.isSignatureUsed(signature);
}

export function claimSignature(
  signature: string,
  payer: string,
): Promise<boolean> {
  return store.claimSignature(signature, payer);
}

export function releaseSignature(signature: string): Promise<void> {
  return store.releaseSignature(signature);
}

export function getSpentLamports(payer: string): Promise<number> {
  return store.getSpentLamports(payer);
}

export function recordSpend(
  payer: string,
  amountLamports: number = PRICE_PER_CALL_LAMPORTS,
): Promise<number> {
  return store.recordSpend(payer, amountLamports);
}

export function getRemainingLamports(
  payer: string,
  limitLamports: number = DEFAULT_SESSION_LIMIT_LAMPORTS,
): Promise<number> {
  return store.getRemainingLamports(payer, limitLamports);
}

export function resetSession(payer?: string): Promise<void> {
  return store.resetSession(payer);
}
