/**
 * POST /api/ask — the paid Summarize tool call.
 *
 * Flow (pay-per-call, DevNet only):
 * 1. The client builds + signs a 0.01 SOL transfer to the agent wallet
 *    (Solana Pay transfer request) and sends the signature here.
 * 2. We verify the payment on-chain (transaction exists, confirmed,
 *    agent wallet received >= 0.01 SOL) and reject replayed signatures.
 * 3. We check the payer's session limit — the client pre-checks this too,
 *    so a hit here means the limit was crossed between check and payment.
 * 4. We run the Summarize tool (Gemini primary with retries, honest
 *    deterministic fallback labeled as such).
 * 5. ONLY after a summary is returned do we record the spend against the
 *    session limit. A failed call = no payment recorded, clear error shown.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_SESSION_LIMIT_LAMPORTS,
  DEFAULT_SESSION_LIMIT_SOL,
  PRICE_PER_CALL_LAMPORTS,
  PRICE_PER_CALL_SOL,
  getRemainingLamports,
  getSpentLamports,
  lamportsToSol,
  recordSpend,
} from "@/lib/pricing";
import {
  getAgentPublicKey,
  getExplorerTxUrl,
  verifyPayment,
} from "@/lib/solana";
import { summarize } from "@/lib/agent";

// NOTE (Next 16): route segment configs `runtime` / `dynamic` are not
// compatible with `cacheComponents: true`, so they are intentionally NOT
// set here. This handler reads the request body and env vars, which makes
// it dynamic at request time by default (route handlers are not cached).

// Signatures already redeemed, so one payment can't buy two summaries.
const usedSignatures = new Set<string>();

const MAX_TEXT_LENGTH = 5000;

export async function POST(req: NextRequest) {
  let body: { text?: string; signature?: string; payer?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  const signature = typeof body.signature === "string" ? body.signature : "";
  const payer = typeof body.payer === "string" ? body.payer : "";

  if (!text) {
    return NextResponse.json(
      { error: "Text to summarize is required." },
      { status: 400 },
    );
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return NextResponse.json(
      { error: `Text must be at most ${MAX_TEXT_LENGTH} characters.` },
      { status: 400 },
    );
  }
  if (!signature || !payer) {
    return NextResponse.json(
      { error: "A confirmed payment signature and payer wallet are required." },
      { status: 400 },
    );
  }
  if (usedSignatures.has(signature)) {
    return NextResponse.json(
      { error: "This payment was already used for a summary." },
      { status: 409 },
    );
  }

  // 1. Verify the on-chain payment before doing any AI work.
  const agentWallet = getAgentPublicKey();
  let verification;
  try {
    verification = await verifyPayment(signature, agentWallet);
  } catch (error) {
    return NextResponse.json(
      {
        error: `Could not verify the payment on DevNet: ${(error as Error).message}`,
      },
      { status: 502 },
    );
  }
  if (!verification.ok) {
    return NextResponse.json(
      { error: `Payment not verified: ${verification.reason}` },
      { status: 402 },
    );
  }

  // 2. Session limit check (client pre-checks; this is the server-side guard).
  const remaining = getRemainingLamports(payer);
  if (remaining < PRICE_PER_CALL_LAMPORTS) {
    return NextResponse.json(
      {
        error:
          "Session spending limit reached — this call is blocked. Start a new session to continue.",
      },
      { status: 402 },
    );
  }

  // 3. Run the tool. Spend is recorded ONLY if a summary comes back.
  let result;
  try {
    result = await summarize(text);
  } catch (error) {
    return NextResponse.json(
      {
        error: `The Summarize tool failed: ${(error as Error).message}. No payment was recorded for this call.`,
      },
      { status: 500 },
    );
  }
  if (!result.summary) {
    return NextResponse.json(
      {
        error:
          "The Summarize tool returned nothing. No payment was recorded for this call.",
      },
      { status: 500 },
    );
  }

  usedSignatures.add(signature);
  const spentAfter = recordSpend(payer);
  const remainingAfter = getRemainingLamports(payer);

  return NextResponse.json({
    summary: result.summary,
    source: result.source,
    model: result.model ?? null,
    fallbackReason: result.fallbackReason ?? null,
    priceSol: PRICE_PER_CALL_SOL,
    spentSol: lamportsToSol(spentAfter),
    remainingSol: lamportsToSol(remainingAfter),
    limitSol: DEFAULT_SESSION_LIMIT_SOL,
    signature,
    explorerUrl: getExplorerTxUrl(signature),
    agentWallet: agentWallet.toBase58(),
    spentLamports: spentAfter,
    remainingLamports: remainingAfter,
    limitLamports: DEFAULT_SESSION_LIMIT_LAMPORTS,
  });
}
