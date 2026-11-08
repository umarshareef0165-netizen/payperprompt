# PayPerPrompt

**Problem in one sentence:** AI agents can't pay for the tools they use — API keys and subscriptions don't work for agents, so PayPerPrompt gives an agent its own Solana wallet and a spending limit, and pays **0.01 SOL per AI tool call via Solana Pay**.

Built by Umar Shareef for the **MLH Solana Hackathon 2026 (AI track)**. Solo, first Solana build.

## How it works

1. **Connect** your Phantom wallet (DevNet) — the app shows your session limit meter (0.5 SOL default).
2. **Paste text** into the Summarize tool and click Ask.
3. **Read the pre-sign explainer first** — plain English: what the transaction will do, that it costs 0.01 SOL, and what will be left of your limit.
4. **Sign in Phantom** — a real 0.01 SOL transfer to the agent wallet on Solana DevNet.
5. **Get the summary** — returned only after the payment is verified on-chain. The transaction links to Solana Explorer, and the meter drops by 0.01 SOL.
6. **Limit block** — when the remaining limit falls below 0.01 SOL, calls are blocked with a clear message before any signature is requested.

One tool, one payment, one limit. No token, no marketplace, no extra pages.

## Live demo

- **Live app:** https://payperprompt-8clp3h9d8-umarshareef0165-7088s-projects.vercel.app/
- **Example DevNet transaction:** https://explorer.solana.com/tx/GJR2vdhq2B7nrPsXArqR1SJydwipXM3iY78jXDJtbm3PKJeixqsXRuiExpbbWgS63Rana6rVtFC3LGpkcXt6qwS?cluster=devnet (0.01 SOL paid call, verified live; meter spent 0.03 / remaining 0.47 after 3 paid calls)
- **Repo:** https://github.com/umarshareef0165-netizen/payperprompt

## Tech

- Next.js 16 + TypeScript (App Router), React 19
- `@solana/web3.js` + `@solana/wallet-adapter-react` (Phantom) + `@solana/pay` transfer requests
- **DevNet only** — RPC `https://api.devnet.solana.com`. Never mainnet, never real SOL. Fund wallets with DevNet airdrops.
- **AI tool:** one tool, "Summarize" (text → short summary).
  - **Primary: Google Gemini** (`gemini-3.8-flash`), server-side only via `GEMINI_API_KEY`, sent as the `x-goog-api-key` header. Retried with backoff on HTTP 503/429.
  - **Honest fallback:** if Gemini is still unavailable (it returned HTTP 503 "high demand" repeatedly during the build weekend), the app returns a deterministic extractive summary and **labels it clearly in the UI as a fallback** ("Fallback summary — Gemini overloaded, deterministic extract"). Fallback output is never presented as an LLM summary.
  - **Never charged on failure:** spend is recorded only after a summary is successfully returned. A failed call = no payment recorded, clear error shown.

## Run locally

```bash
npm install
cp .env.local.example .env.local   # then fill in GEMINI_API_KEY (see below)
npm run dev                        # http://localhost:3000
```

### Environment variables (`.env.local`, gitignored — never commit)

| Variable | Value |
| --- | --- |
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` |
| `GEMINI_API_KEY` | Gemini API key from Google AI Studio (PayPerPrompt project). Server-side only. |
| `AGENT_WALLET_SECRET` | JSON array of the agent wallet's 64 secret-key bytes (DevNet only). Generated once; if missing, the server generates an ephemeral wallet per process and logs its address. |

## Tests

```bash
npm test        # vitest unit tests: pricing + limit logic, fallback summary, explainer text
npm run build   # must pass with zero errors before deploy
```

## Live DevNet checklist (manual — run before submitting)

- [ ] Phantom switched to DevNet, funded with a DevNet airdrop
- [ ] Connect wallet → meter shows 0.50 / 0.50 SOL
- [ ] Paste text → explainer shows cost 0.01 SOL + remaining after payment
- [ ] Confirm in Phantom → transaction confirms
- [ ] Explorer link opens and shows the 0.01 SOL transfer to the agent wallet
- [ ] Meter drops to 0.49 SOL; summary appears (labeled Gemini or Fallback)
- [ ] Second call works the same way
- [ ] After 50 calls (or with a lowered test limit) the next call is blocked before signing, with the limit message
- [ ] Fresh-browser check of the deployed Vercel URL

## Submission

- MLH Challenges: https://www.mlh.com/events/solana-hackathon — submissions close Nov 8, 1:00 PM EST (10:00 AM PST, verified on the form page Nov 7, 06:57 PST); aim for the 7:00 AM PT initial window
- Demo video (≤2:00, own voice): _TODO — YouTube link after recording_
