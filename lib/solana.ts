/**
 * Solana helpers for PayPerPrompt — DevNet ONLY.
 *
 * - Connection to the DevNet RPC.
 * - The agent wallet: a Keypair loaded from AGENT_WALLET_SECRET (JSON array
 *   of secret-key bytes, server-side only). If the env var is missing, an
 *   ephemeral keypair is generated for the process and its public key is
 *   logged — payments still work, but the wallet does not survive restarts.
 * - Solana Pay transfer-request URL builder (the `solana:` URL the user
 *   signs; the actual transfer is sent with @solana/web3.js).
 * - On-chain payment verification: confirms a transaction signature on
 *   DevNet and checks the agent wallet actually received >= 0.01 SOL.
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import { encodeURL } from "@solana/pay";
import BigNumber from "bignumber.js";
import { PRICE_PER_CALL_LAMPORTS, PRICE_PER_CALL_SOL } from "./pricing";

export const DEVNET_RPC_URL =
  process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

export const EXPLORER_CLUSTER = "devnet";

let connection: Connection | null = null;

export function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(DEVNET_RPC_URL, "confirmed");
  }
  return connection;
}

let agentWallet: Keypair | null = null;

/** The agent's own DevNet wallet (server-side only — never sent to clients). */
export function getAgentWallet(): Keypair {
  if (agentWallet) return agentWallet;

  const secret = process.env.AGENT_WALLET_SECRET;
  if (secret) {
    try {
      const bytes = Uint8Array.from(JSON.parse(secret) as number[]);
      agentWallet = Keypair.fromSecretKey(bytes);
      return agentWallet;
    } catch {
      console.warn(
        "[payperprompt] AGENT_WALLET_SECRET is set but invalid; generating an ephemeral agent wallet.",
      );
    }
  }

  agentWallet = Keypair.generate();
  console.warn(
    `[payperprompt] No AGENT_WALLET_SECRET set — using an ephemeral agent wallet ${agentWallet.publicKey.toBase58()}. Set AGENT_WALLET_SECRET in .env.local to persist it.`,
  );
  return agentWallet;
}

export function getAgentPublicKey(): PublicKey {
  return getAgentWallet().publicKey;
}

/** Public Solana Explorer link for a DevNet transaction signature. */
export function getExplorerTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=${EXPLORER_CLUSTER}`;
}

/** Public Solana Explorer link for a DevNet account. */
export function getExplorerAccountUrl(publicKey: string): string {
  return `https://explorer.solana.com/address/${publicKey}?cluster=${EXPLORER_CLUSTER}`;
}

export interface SolanaPayRequest {
  /** The `solana:` transfer-request URL (Solana Pay). */
  url: string;
  recipient: string;
  amountSol: number;
  amountLamports: number;
  label: string;
  message: string;
}

/**
 * Build a Solana Pay transfer request for one paid tool call:
 * the user's wallet pays PRICE_PER_CALL_SOL to the agent wallet.
 */
export function buildSolanaPayRequest(
  recipient: PublicKey,
  label = "PayPerPrompt",
  message = "PayPerPrompt — one Summarize tool call",
): SolanaPayRequest {
  const url = encodeURL({
    recipient,
    amount: new BigNumber(PRICE_PER_CALL_SOL),
    label,
    message,
  }).toString();

  return {
    url,
    recipient: recipient.toBase58(),
    amountSol: PRICE_PER_CALL_SOL,
    amountLamports: PRICE_PER_CALL_LAMPORTS,
    label,
    message,
  };
}

export interface PaymentVerification {
  ok: boolean;
  receivedLamports: number;
  reason?: string;
}

/**
 * Verify an on-chain payment: the transaction must exist on DevNet,
 * be confirmed with no error, and have moved at least the expected
 * lamports into the agent wallet.
 */
export async function verifyPayment(
  signature: string,
  expectedRecipient: PublicKey,
  expectedLamports: number = PRICE_PER_CALL_LAMPORTS,
): Promise<PaymentVerification> {
  const connection = getConnection();

  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) {
    return {
      ok: false,
      receivedLamports: 0,
      reason: "Transaction not found on DevNet (yet).",
    };
  }
  if (tx.meta?.err) {
    return {
      ok: false,
      receivedLamports: 0,
      reason: "Transaction failed on-chain.",
    };
  }

  const keys = tx.transaction.message.getAccountKeys();
  const index = keys.staticAccountKeys.findIndex((key) =>
    key.equals(expectedRecipient),
  );
  if (index === -1) {
    return {
      ok: false,
      receivedLamports: 0,
      reason: "Agent wallet is not part of this transaction.",
    };
  }

  const pre = tx.meta?.preBalances?.[index] ?? 0;
  const post = tx.meta?.postBalances?.[index] ?? 0;
  const receivedLamports = post - pre;

  if (receivedLamports < expectedLamports) {
    return {
      ok: false,
      receivedLamports,
      reason: `Agent wallet received ${receivedLamports / LAMPORTS_PER_SOL} SOL, expected ${expectedLamports / LAMPORTS_PER_SOL} SOL.`,
    };
  }

  return { ok: true, receivedLamports };
}
