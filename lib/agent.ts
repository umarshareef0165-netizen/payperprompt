/**
 * The one PayPerPrompt tool: "Summarize" (input text -> short summary).
 *
 * Primary: Google Gemini (gemini-3.8-flash), server-side only, via the
 * GEMINI_API_KEY env var sent as the `x-goog-api-key` header to
 * generativelanguage.googleapis.com. Never a Bearer token, never a ?key= URL.
 *
 * Gemini is flaky under load (HTTP 503 "high demand" seen repeatedly on
 * 2026-11-06), so generate is retried with backoff on 503/429. If Gemini
 * still fails, an honest deterministic extractive summary is returned and
 * LABELED as a fallback in the UI and the API response — fallback output is
 * never presented as an LLM summary.
 *
 * A failed tool call never charges: the caller must only record spend after
 * a summary is successfully returned.
 */

export const GEMINI_MODEL = "gemini-3.8-flash";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1000, 2000]; // backoff between attempts 1->2, 2->3

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ToolResult {
  summary: string;
  /** "gemini" = real LLM summary; "fallback" = deterministic extract. */
  source: "gemini" | "fallback";
  model?: string;
  /** Why the fallback was used, when source is "fallback". */
  fallbackReason?: string;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
}

/** One Gemini generate call. Throws an Error with a `status` property on HTTP failure. */
async function callGeminiOnce(text: string, apiKey: string): Promise<string> {
  const prompt = `Summarize the following text in 2-3 short sentences. Keep only the key points, no preamble, no bullet list:\n\n${text}`;

  const res = await fetch(GEMINI_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 200, temperature: 0.3 },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const error = new Error(
      `Gemini ${GEMINI_MODEL} returned HTTP ${res.status}: ${body.slice(0, 200)}`,
    ) as Error & { status: number };
    error.status = res.status;
    throw error;
  }

  const data = (await res.json()) as GeminiResponse;
  const summary = data.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("")
    .trim();

  if (!summary) {
    throw new Error("Gemini returned an empty summary.");
  }
  return summary;
}

/** Gemini with retry + backoff on 503/429 (transient overload / rate limit). */
export async function summarizeWithGemini(
  text: string,
  apiKey: string,
): Promise<string> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await callGeminiOnce(text, apiKey);
    } catch (error) {
      lastError = error;
      const status = (error as { status?: number }).status;
      const retryable = status === 503 || status === 429;
      if (!retryable || attempt === MAX_ATTEMPTS) break;
      await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 2000);
    }
  }
  throw lastError;
}

const STOPWORDS = new Set(
  "a an the and or but if then else for of to in on at by with from as is are was were be been being it its this that these those we you he she they them his her their our your i me my we us have has had do does did will would can could should may might not no yes so than too very just also more most other some any each every all both few much many".split(
    " ",
  ),
);

/**
 * Deterministic extractive summary: scores sentences by word frequency
 * (stopwords excluded) and returns the top 2-3 in their original order.
 * No LLM involved — always labeled as a fallback.
 */
export function deterministicSummary(text: string): string {
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (sentences.length === 0) return "";
  if (sentences.length <= 3) return sentences.join(" ");

  const freq = new Map<string, number>();
  for (const word of text.toLowerCase().match(/[a-z0-9']+/g) ?? []) {
    if (STOPWORDS.has(word)) continue;
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }

  const scored = sentences.map((sentence, index) => {
    const words = sentence.toLowerCase().match(/[a-z0-9']+/g) ?? [];
    const score =
      words.reduce((sum, w) => sum + (freq.get(w) ?? 0), 0) /
      Math.max(1, words.length);
    return { sentence, index, score };
  });

  const top = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .sort((a, b) => a.index - b.index);

  return top.map((item) => item.sentence).join(" ");
}

/**
 * Run the Summarize tool. Gemini first (with retries); deterministic
 * fallback, clearly labeled, if Gemini is unavailable or still failing.
 */
export async function summarize(text: string): Promise<ToolResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      summary: deterministicSummary(text),
      source: "fallback",
      fallbackReason: "No Gemini API key configured — deterministic extract.",
    };
  }

  try {
    const summary = await summarizeWithGemini(text, apiKey);
    return { summary, source: "gemini", model: GEMINI_MODEL };
  } catch (error) {
    const status = (error as { status?: number }).status;
    const reason =
      status === 503
        ? "Gemini overloaded (HTTP 503) — deterministic extract."
        : status === 429
          ? "Gemini rate-limited (HTTP 429) — deterministic extract."
          : `Gemini unavailable (${(error as Error).message.slice(0, 120)}) — deterministic extract.`;
    return {
      summary: deterministicSummary(text),
      source: "fallback",
      fallbackReason: reason,
    };
  }
}

/**
 * Plain-English pre-sign explainer: what the transaction will do, what it
 * costs, and what will be left of the session limit. Shown BEFORE signing.
 */
export function buildExplainerText(input: {
  toolName: string;
  costSol: number;
  remainingBeforeSol: number;
  limitSol: number;
}): string {
  const remainingAfter = Math.max(
    0,
    input.remainingBeforeSol - input.costSol,
  );
  return (
    `This transaction will pay ${input.costSol.toFixed(2)} SOL to the PayPerPrompt agent wallet ` +
    `for one "${input.toolName}" tool call. ` +
    `After this payment you will have ${remainingAfter.toFixed(2)} SOL left ` +
    `of your ${input.limitSol.toFixed(2)} SOL session limit. ` +
    `Nothing else will be charged.`
  );
}
