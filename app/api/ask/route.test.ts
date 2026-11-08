/**
 * Route-level tests for POST /api/ask (app/api/ask/route.ts).
 *
 * The on-chain verifier and the Summarize tool are mocked; the replay
 * guard, session-limit guard, charging, and meter values are the real
 * code paths. Each test uses its own signature so the module-level
 * redeemed-signature set never leaks between tests.
 * Run with: npm test
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";

vi.mock("@/lib/solana", () => ({
  getAgentPublicKey: () =>
    new PublicKey("8U5KCb2L5UrNNxAJ2A6U15zvVc2jSDBbntHo2VjTUrq5"),
  getExplorerTxUrl: (sig: string) =>
    `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
  verifyPayment: vi.fn(),
}));

vi.mock("@/lib/agent", () => ({
  summarize: vi.fn(),
}));

import { POST } from "./route";
import { verifyPayment } from "@/lib/solana";
import { summarize } from "@/lib/agent";
import {
  getSpentLamports,
  recordSpend,
  resetSession,
  PRICE_PER_CALL_LAMPORTS,
  DEFAULT_SESSION_LIMIT_LAMPORTS,
} from "@/lib/pricing";

const mockedVerify = vi.mocked(verifyPayment);
const mockedSummarize = vi.mocked(summarize);

const PAYER = "TestPayer111111111111111111111111111111111";
const TEXT = "PayPerPrompt charges 0.01 SOL per call. The session limit is 0.5 SOL. Payments run on Solana DevNet.";

/** Minimal request stub — the handler only reads req.json(). */
function makeReq(body: unknown) {
  return {
    json: async () => body,
  } as unknown as Parameters<typeof POST>[0];
}

function badJsonReq() {
  return {
    json: async () => {
      throw new Error("Unexpected token in JSON");
    },
  } as unknown as Parameters<typeof POST>[0];
}

function askBody(signature: string, text: string = TEXT) {
  return { text, signature, payer: PAYER };
}

beforeEach(() => {
  resetSession();
  vi.clearAllMocks();
  mockedVerify.mockResolvedValue({
    ok: true,
    receivedLamports: PRICE_PER_CALL_LAMPORTS,
  });
  mockedSummarize.mockResolvedValue({
    summary: "Mock summary.",
    source: "gemini",
    model: "gemini-3.8-flash",
  });
});

describe("POST /api/ask — fresh payment", () => {
  it("returns 200 with a summary and charges exactly 0.01 SOL", async () => {
    const res = await POST(makeReq(askBody("sig-fresh-1")));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.summary).toBe("Mock summary.");
    expect(body.source).toBe("gemini");
    expect(body.spentSol).toBe(0.01);
    expect(body.remainingSol).toBe(0.49);
    expect(body.spentLamports).toBe(PRICE_PER_CALL_LAMPORTS);
    expect(getSpentLamports(PAYER)).toBe(PRICE_PER_CALL_LAMPORTS);
    expect(mockedVerify).toHaveBeenCalledTimes(1);
    expect(mockedSummarize).toHaveBeenCalledTimes(1);
  });

  it("second fresh signature reads the post-charge meter (no lag)", async () => {
    const first = await POST(makeReq(askBody("sig-fresh-2a")));
    expect(first.status).toBe(200);
    expect(((await first.json()) as Record<string, unknown>).spentSol).toBe(
      0.01,
    );
    const second = await POST(makeReq(askBody("sig-fresh-2b")));
    expect(second.status).toBe(200);
    const body = (await second.json()) as Record<string, unknown>;
    // Post-charge values: 2 calls = 0.02 spent, 0.48 remaining.
    expect(body.spentSol).toBe(0.02);
    expect(body.remainingSol).toBe(0.48);
    expect(getSpentLamports(PAYER)).toBe(2 * PRICE_PER_CALL_LAMPORTS);
  });
});

describe("POST /api/ask — replay protection", () => {
  it("reusing a signature returns 409, no new summary, no charge", async () => {
    const first = await POST(makeReq(askBody("sig-replay-1", TEXT)));
    expect(first.status).toBe(200);
    expect(getSpentLamports(PAYER)).toBe(PRICE_PER_CALL_LAMPORTS);

    const replay = await POST(
      makeReq(askBody("sig-replay-1", "Different text, same payment.")),
    );
    expect(replay.status).toBe(409);
    const body = (await replay.json()) as Record<string, unknown>;
    expect(String(body.error)).toContain("already used");
    // No second summary, no second charge.
    expect(mockedSummarize).toHaveBeenCalledTimes(1);
    expect(getSpentLamports(PAYER)).toBe(PRICE_PER_CALL_LAMPORTS);
  });

  it("a failed tool call releases the signature so the payment can be retried", async () => {
    mockedSummarize.mockRejectedValueOnce(new Error("Gemini exploded"));
    const failed = await POST(makeReq(askBody("sig-retry-1")));
    expect(failed.status).toBe(500);
    expect(getSpentLamports(PAYER)).toBe(0);

    // Same payment retries cleanly once the tool works again.
    const retry = await POST(makeReq(askBody("sig-retry-1")));
    expect(retry.status).toBe(200);
    expect(getSpentLamports(PAYER)).toBe(PRICE_PER_CALL_LAMPORTS);
  });
});

describe("POST /api/ask — payment verification failures", () => {
  it("fake signature (verification fails) returns 402 and charges nothing", async () => {
    mockedVerify.mockResolvedValue({
      ok: false,
      receivedLamports: 0,
      reason: "Transaction not found on DevNet (yet).",
    });
    const res = await POST(makeReq(askBody("sig-fake-1")));
    expect(res.status).toBe(402);
    expect(getSpentLamports(PAYER)).toBe(0);
    expect(mockedSummarize).not.toHaveBeenCalled();
  });

  it("verifier error returns 502 and charges nothing", async () => {
    mockedVerify.mockRejectedValue(new Error("RPC down"));
    const res = await POST(makeReq(askBody("sig-err-1")));
    expect(res.status).toBe(502);
    expect(getSpentLamports(PAYER)).toBe(0);
    expect(mockedSummarize).not.toHaveBeenCalled();
  });
});

describe("POST /api/ask — bad input", () => {
  it("bad JSON returns 400", async () => {
    const res = await POST(badJsonReq());
    expect(res.status).toBe(400);
  });

  it("missing text returns 400", async () => {
    const res = await POST(
      makeReq({ text: "", signature: "sig-x", payer: PAYER }),
    );
    expect(res.status).toBe(400);
  });

  it("missing signature returns 400", async () => {
    const res = await POST(makeReq({ text: TEXT, signature: "", payer: PAYER }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/ask — session limit", () => {
  it("blocks at the limit with 402 and does NOT consume the signature", async () => {
    for (let i = 0; i < 50; i++) recordSpend(PAYER);
    expect(getSpentLamports(PAYER)).toBe(DEFAULT_SESSION_LIMIT_LAMPORTS);

    const blocked = await POST(makeReq(askBody("sig-limit-1")));
    expect(blocked.status).toBe(402);
    expect(mockedSummarize).not.toHaveBeenCalled();

    // The payment was not consumed: after a fresh session it works.
    resetSession();
    const retry = await POST(makeReq(askBody("sig-limit-1")));
    expect(retry.status).toBe(200);
  });
});

describe("POST /api/ask — fallback labelling preserved", () => {
  it("keeps source=fallback and fallbackReason in the 200 response", async () => {
    mockedSummarize.mockResolvedValue({
      summary: "Fallback summary.",
      source: "fallback",
      fallbackReason: "Gemini overloaded (HTTP 503) — deterministic extract.",
    });
    const res = await POST(makeReq(askBody("sig-fallback-1")));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.source).toBe("fallback");
    expect(body.fallbackReason).toContain("503");
    expect(body.spentSol).toBe(0.01);
  });
});
