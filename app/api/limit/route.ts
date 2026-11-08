/**
 * GET /api/limit?payer=<wallet address> — session spending-limit status.
 * Used by the UI meter (before the user signs anything) and as the
 * pre-payment affordability check.
 *
 * Spend is read from Neon (lib/db.ts), the single source of truth across
 * every serverless instance. If the DB is unreachable the route fails
 * closed (500) instead of reporting a wrong 0.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_SESSION_LIMIT_LAMPORTS,
  DEFAULT_SESSION_LIMIT_SOL,
  PRICE_PER_CALL_LAMPORTS,
  PRICE_PER_CALL_SOL,
  canAffordCall,
  lamportsToSol,
  meterPercent,
} from "@/lib/pricing";
import { getRemainingLamports, getSpentLamports } from "@/lib/db";
import { getAgentPublicKey, getExplorerAccountUrl } from "@/lib/solana";

// NOTE (Next 16): route segment configs `runtime` / `dynamic` are not
// compatible with `cacheComponents: true`, so they are intentionally NOT
// set here. This handler reads request search params, which makes it
// dynamic at request time by default (route handlers are not cached).

export async function GET(req: NextRequest) {
  const payer = req.nextUrl.searchParams.get("payer") ?? "";
  const agentWallet = getAgentPublicKey().toBase58();

  let spent = 0;
  let remaining = DEFAULT_SESSION_LIMIT_LAMPORTS;
  if (payer) {
    try {
      spent = await getSpentLamports(payer);
      remaining = await getRemainingLamports(payer);
    } catch (error) {
      return NextResponse.json(
        {
          error:
            "The spend store is unavailable — the meter cannot be read. " +
            `(${(error as Error).message})`,
        },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({
    payer: payer || null,
    agentWallet,
    agentWalletExplorerUrl: getExplorerAccountUrl(agentWallet),
    priceSol: PRICE_PER_CALL_SOL,
    priceLamports: PRICE_PER_CALL_LAMPORTS,
    limitSol: DEFAULT_SESSION_LIMIT_SOL,
    limitLamports: DEFAULT_SESSION_LIMIT_LAMPORTS,
    spentSol: lamportsToSol(spent),
    spentLamports: spent,
    remainingSol: lamportsToSol(remaining),
    remainingLamports: remaining,
    meterPercent: meterPercent(remaining),
    canAfford: payer ? canAffordCall(spent) : true,
  });
}
