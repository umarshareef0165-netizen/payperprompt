"use client";

import { useCallback, useEffect, useState } from "react";
import {
  useConnection,
  useWallet,
} from "@solana/wallet-adapter-react";
import {
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import WalletButton from "@/components/WalletButton";
import LimitMeter from "@/components/LimitMeter";
import Explainer from "@/components/Explainer";
import { buildExplainerText } from "@/lib/agent";
import {
  PRICE_PER_CALL_LAMPORTS,
  PRICE_PER_CALL_SOL,
  DEFAULT_SESSION_LIMIT_SOL,
} from "@/lib/pricing";
import { buildSolanaPayRequest } from "@/lib/solana";

interface LimitState {
  remainingSol: number;
  spentSol: number;
  limitSol: number;
  meterPercent: number;
  canAfford: boolean;
  agentWallet: string;
  agentWalletExplorerUrl: string;
}

interface AskResult {
  summary: string;
  source: "gemini" | "fallback";
  model: string | null;
  fallbackReason: string | null;
  priceSol: number;
  remainingSol: number;
  signature: string;
  explorerUrl: string;
}

const SAMPLE_TEXT =
  "PayPerPrompt is an agent with its own Solana DevNet wallet and a spending limit. " +
  "It pays per AI tool call in SOL via Solana Pay, and before you sign anything it explains the transaction in plain English: " +
  "what it will do, what it costs, and what will be left of your limit. " +
  "AI agents cannot use API keys or subscriptions the way people do, so machine payments are how agents become economically independent — " +
  "and spending limits are what make that safe.";

export default function Home() {
  const { connection } = useConnection();
  const { publicKey, connected, sendTransaction } = useWallet();

  const [text, setText] = useState("");
  const [limit, setLimit] = useState<LimitState | null>(null);
  const [explainer, setExplainer] = useState<{
    text: string;
    payUrl: string;
    recipient: string;
  } | null>(null);
  const [result, setResult] = useState<AskResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<string>("");

  const refreshLimit = useCallback(async () => {
    const payer = publicKey?.toBase58() ?? "";
    const res = await fetch(`/api/limit?payer=${payer}`);
    if (!res.ok) return;
    const data = (await res.json()) as LimitState;
    setLimit(data);
  }, [publicKey]);

  useEffect(() => {
    refreshLimit().catch(() => undefined);
  }, [refreshLimit]);

  const handleAsk = async () => {
    setError(null);
    setResult(null);
    setExplainer(null);

    if (!connected || !publicKey) {
      setError("Connect your Phantom wallet first (switch Phantom to DevNet).");
      return;
    }
    if (!text.trim()) {
      setError("Paste or type some text to summarize first.");
      return;
    }

    setBusy(true);
    try {
      // 1. Affordability pre-check — never ask the user to sign a call
      //    the session limit cannot cover.
      setPhase("Checking your session limit…");
      const limitRes = await fetch(`/api/limit?payer=${publicKey.toBase58()}`);
      const limitData = (await limitRes.json()) as LimitState;
      setLimit(limitData);
      if (!limitData.canAfford) {
        setError(
          "Session spending limit reached — this call is blocked. Start a new session to continue.",
        );
        return;
      }

      // 2. Pre-sign explainer (shown BEFORE any signature is requested).
      const payRequest = buildSolanaPayRequest(
        new PublicKey(limitData.agentWallet),
      );
      setExplainer({
        text: buildExplainerText({
          toolName: "Summarize",
          costSol: PRICE_PER_CALL_SOL,
          remainingBeforeSol: limitData.remainingSol,
          limitSol: limitData.limitSol,
        }),
        payUrl: payRequest.url,
        recipient: payRequest.recipient,
      });

      // 3. Build + sign the 0.01 SOL Solana Pay transfer in Phantom.
      setPhase("Waiting for your signature in Phantom…");
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: new PublicKey(limitData.agentWallet),
          lamports: PRICE_PER_CALL_LAMPORTS,
        }),
      );
      transaction.feePayer = publicKey;
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;

      const signature = await sendTransaction(transaction, connection);
      setPhase("Payment sent — confirming on DevNet…");
      await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed",
      );

      // 4. Only now does the server run the tool (payment verified on-chain).
      setPhase("Payment confirmed — running the Summarize tool…");
      const askRes = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          signature,
          payer: publicKey.toBase58(),
        }),
      });
      const askData = (await askRes.json()) as AskResult & { error?: string };
      if (!askRes.ok) {
        throw new Error(askData.error ?? "The tool call failed.");
      }
      setResult(askData);
      await refreshLimit();
    } catch (err) {
      const message = (err as Error).message ?? "Something went wrong.";
      if (/rejected|denied|user rejected/i.test(message)) {
        setError("You declined the transaction in Phantom — nothing was paid.");
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
      setPhase("");
    }
  };

  return (
    <main className="page">
      <header className="hero">
        <p className="eyebrow">MLH Solana Hackathon · AI track · DevNet only</p>
        <h1>PayPerPrompt</h1>
        <p className="tagline">
          An agent with its own Solana wallet and a spending limit — paying{" "}
          <strong>0.01 SOL per AI tool call</strong> via Solana Pay.
        </p>
        <p className="tagline-sub">
          AI agents can&apos;t use API keys or subscriptions. Machine payments
          are how agents pay for the tools they use — and spending limits are
          what make it safe.
        </p>
        <div className="hero-actions">
          <WalletButton />
        </div>
        <p className="devnet-note">
          DevNet only — no real SOL. In Phantom, switch to DevNet and airdrop
          test SOL before trying a call.
        </p>
      </header>

      <section className="card">
        <h2>1 · The tool — Summarize</h2>
        <p>
          Paste text, pay 0.01 SOL, get a short summary back. The agent wallet
          receives the payment; the summary is returned only after the payment
          is confirmed on DevNet.
        </p>
        <label className="label" htmlFor="input-text">
          Text to summarize
        </label>
        <textarea
          id="input-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste a paragraph here…"
          rows={6}
          maxLength={5000}
        />
        <div className="sample-row">
          <button
            type="button"
            className="link-button"
            onClick={() => setText(SAMPLE_TEXT)}
          >
            Use sample text
          </button>
          <span>{text.length} / 5000 characters</span>
        </div>
      </section>

      {limit && (
        <section className="card">
          <h2>2 · Your session limit</h2>
          <LimitMeter
            remainingSol={limit.remainingSol}
            limitSol={limit.limitSol}
            spentSol={limit.spentSol}
            meterPercent={limit.meterPercent}
          />
          <p className="agent-wallet">
            Agent wallet:{" "}
            <a
              href={limit.agentWalletExplorerUrl}
              target="_blank"
              rel="noreferrer"
            >
              {limit.agentWallet}
            </a>
          </p>
        </section>
      )}

      <section className="card">
        <h2>3 · Pay &amp; run the tool</h2>
        {explainer && <Explainer {...explainer} />}
        <button
          type="button"
          className="button button-primary button-large"
          disabled={busy || !connected}
          onClick={handleAsk}
        >
          {busy
            ? phase || "Working…"
            : `Ask — pay ${PRICE_PER_CALL_SOL.toFixed(2)} SOL`}
        </button>
        {!connected && (
          <p className="hint">Connect Phantom to enable the paid call.</p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>

      {result && (
        <section className="card result">
          <h2>Summary</h2>
          {result.source === "gemini" ? (
            <p className="source-badge source-gemini">
              AI summary · {result.model ?? "Gemini"}
            </p>
          ) : (
            <p className="source-badge source-fallback" role="note">
              Fallback summary — Gemini overloaded, deterministic extract. This
              is not an LLM summary.
              {result.fallbackReason ? ` (${result.fallbackReason})` : ""}
            </p>
          )}
          <p className="summary-text">{result.summary}</p>
          <dl className="result-details">
            <div>
              <dt>Paid</dt>
              <dd>{result.priceSol.toFixed(2)} SOL</dd>
            </div>
            <div>
              <dt>Remaining in limit</dt>
              <dd>{result.remainingSol.toFixed(2)} SOL</dd>
            </div>
            <div>
              <dt>Transaction</dt>
              <dd>
                <a href={result.explorerUrl} target="_blank" rel="noreferrer">
                  View on Solana Explorer (DevNet)
                </a>
              </dd>
            </div>
          </dl>
        </section>
      )}

      <footer className="footer">
        <p>
          PayPerPrompt · MLH Solana Hackathon 2026 · Built by Umar Shareef ·
          DevNet only, never mainnet. Default session limit{" "}
          {DEFAULT_SESSION_LIMIT_SOL.toFixed(2)} SOL · 0.01 SOL per call.
        </p>
      </footer>
    </main>
  );
}
