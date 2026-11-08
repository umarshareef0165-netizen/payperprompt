/**
 * POST /api/ask — the paid Summarize tool call.
 *
 * Flow (pay-per-call, DevNet only):
 * 1. The client builds + signs a 0.01 SOL transfer to the agent wallet
 *    (Solana Pay transfer request) and sends the signature here.
 * 2. We check the durable store (Neon Postgres, lib/db.ts) — a signature
 *    already redeemed returns 409 before any AI work happens.
 * 3. We verify the payment on-chain (transaction exists, confirmed,
 *    agent wallet received >= 0.01 SOL) and reject bad payments.
 * 4. We check the payer's session limit in the DB — the client pre-checks
 *    this too, so a hit here means the limit was crossed between check
 *    and payment. A limit block never claims the signature.
 * 5. We claim the signature in the DB BEFORE running the tool. The claim
 *    is a single INSERT guarded by the table's PRIMARY KEY, so a
 *    concurrent replay on another Vercel instance loses the race and gets
 *    409 — no summary, no charge. If the tool fails, the claim is
 *    released and the payment can be retried — a failed call never burns
 *    the payment.
 * 6. We run the Summarize tool (Gemini primary with retries, honest
 *    deterministic fallback labeled as such).
 * 7. ONLY after a summary is returned do we record the spend in the DB.
 *    The response's spent/remaining values are read from that same
 *    charge, so the meter in the response never lags the true total.
 *    If the charge write fails, the claim is released (payment not
 *    burned) and the call returns 500.
 *
 * The replay guard and the meter are durable across every serverless
 * instance because both live in Neon, not in this process's memory.
 * Any DB failure fails the call closed (500, no summary, no charge).
 */

import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_SESSION_LIMIT_LAMPORTS,
  DEFAULT_SESSION_LIMIT_SOL,
  PRICE_PER_CALL_LAMPORTS,
  PRICE_PER_CALL_SOL,
  lamportsToSol,
  remainingLamports,
} from "@/lib/pricing";
import {
  claimSignature,
  getRemainingLamports,
  isSignatureUsed,
  recordSpend,
  releaseSignature,
} from "@/lib/db";
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

const MAX_TEXT_LENGTH = 5000;

function storeUnavailable(error: unknown) {
  return NextResponse.json(
    {
      error:
        "The spend store is unavailable — no summary was produced and no " +
        `payment was recorded. (${(error as Error).message})`,
    },
    { status: 500 },
  );
}

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

  // 2. Durable replay check (fast path, before any AI work).
  let alreadyUsed: boolean;
  try {
    alreadyUsed = await isSignatureUsed(signature);
  } catch (error) {
    return storeUnavailable(error);
  }
  if (alreadyUsed) {
    return NextResponse.json(
      { error: "This payment was already used for a summary." },
      { status: 409 },
    );
  }

  // 3. Verify the on-chain payment before doing any AI work.
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

  // 4. Session limit check (client pre-checks; this is the server-side guard).
  // A limit block never claims the signature.
  let remaining: number;
  try {
    remaining = await getRemainingLamports(payer);
  } catch (error) {
    return storeUnavailable(error);
  }
  if (remaining < PRICE_PER_CALL_LAMPORTS) {
    return NextResponse.json(
      {
        error:
          "Session spending limit reached — this call is blocked. Start a new session to continue.",
      },
      { status: 402 },
    );
  }

  // 5. Claim the signature in the DB BEFORE running the tool (see header
  // step 5). A false return means a concurrent replay claimed it first.
  let claimed: boolean;
  try {
    claimed = await claimSignature(signature, payer);
  } catch (error) {
    return storeUnavailable(error);
  }
  if (!claimed) {
    return NextResponse.json(
      { error: "This payment was already used for a summary." },
      { status: 409 },
    );
  }

  // 6. Run the tool. Spend is recorded ONLY if a summary comes back.
  let result;
  try {
    result = await summarize(text);
  } catch (error) {
    // Tool failed: release the claim so the same payment can be retried.
    await releaseSignature(signature).catch(() => undefined);
    return NextResponse.json(
      {
        error: `The Summarize tool failed: ${(error as Error).message}. No payment was recorded for this call.`,
      },
      { status: 500 },
    );
  }
  if (!result.summary) {
    // Empty result: same release — the payment is not burned.
    await releaseSignature(signature).catch(() => undefined);
    return NextResponse.json(
      {
        error:
          "The Summarize tool returned nothing. No payment was recorded for this call.",
      },
      { status: 500 },
    );
  }

  // 7. Charge the session in the DB. If the charge write fails, release
  // the claim (payment not burned) and fail closed. The response meter
  // is computed from the charge itself, so it never lags the true total.
  let spentAfter: number;
  try {
    spentAfter = await recordSpend(payer);
  } catch (error) {
    await releaseSignature(signature).catch(() => undefined);
    return storeUnavailable(error);
  }
  const remainingAfter = remainingLamports(spentAfter);

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
