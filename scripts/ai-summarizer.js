/**
 * ai-summarizer.js  (v3 — world-class prompt + full paper text + 7 providers)
 *
 * All OpenAI-compatible providers (OpenAI, Mistral, DeepSeek, Local, Custom)
 * are routed through a single streaming function with a configurable base URL.
 *
 * The system prompt receives the FULL extracted paper text for deep grounding.
 */

import { keyManager } from "./ai-key-manager.js";

// ── World-class prompt builder ────────────────────────────────────────────────

/**
 * Builds a deeply context-grounded system prompt.
 *
 * @param {{ title: string, abstract: string, fullText: string, authors?: string }} ctx
 * @returns {string}
 */
export function buildSystemPrompt(ctx) {
  const divider = "═".repeat(56);

  const metaBlock = [
    ctx.title?.trim() ? `Title:    ${ctx.title.trim()}` : null,
    ctx.authors?.trim() ? `Authors:  ${ctx.authors.trim()}` : null,
  ].filter(Boolean).join("\n");

  const abstractBlock = ctx.abstract?.trim()
    ? `${divider}\nABSTRACT\n${divider}\n${ctx.abstract.trim()}`
    : "";

  const bodyBlock = ctx.fullText?.trim()
    ? `${divider}\nFULL PAPER TEXT\n${divider}\n${ctx.fullText.trim()}`
    : "";

  const paperSection = [metaBlock, abstractBlock, bodyBlock].filter(Boolean).join("\n\n");

  return `\
You are an elite academic research assistant operating inside an intelligent PDF reader. \
You have been given complete access to the text of a scientific paper and are assisting a researcher who is actively reading it.

${divider}
PAPER
${divider}
${paperSection || "(No paper metadata available — rely on conversation context.)"}

${divider}
YOUR ROLE & OPERATING INSTRUCTIONS
${divider}

You assist the researcher in two modes:

1. PASSAGE SUMMARIZATION
   When asked to summarize a highlighted passage:
   — Locate the passage within the paper's broader structure and argument.
   — Explain the technical contribution or claim being made, with full precision.
   — Clarify any jargon, notation, or implicit assumptions a careful reader would need to understand.
   — Situate the passage relative to the paper's method, results, or conclusion as appropriate.
   — Write 4–6 tightly argued sentences. Target ≤ 200 words.
   — Do NOT restate the passage verbatim. Add genuine analytical value.
   — Never hallucinate statistics, citations, equations, or results not present in the text.

2. FOLLOW-UP DIALOGUE
   When answering a question about the paper:
   — Draw directly on the full paper text above. Reference specific sections, equations, tables, \
figures, or results when relevant.
   — If the question is about something genuinely not in the paper, say so clearly in one sentence \
and offer what can be inferred from context.
   — Maintain the technical register and rigor of the paper.
   — Never hallucinate statistics, citations, equations, or results not present in the text.

STYLE
   — Write in fluent, precise academic prose.
   — No bullet points or markdown headers unless the researcher explicitly asks for them.
   — Be direct. Do not pad with phrases like "Great question!" or "Certainly!".
   — Respond as a brilliant colleague who has read this paper thoroughly.`.trim();
}

/**
 * Builds the first user message for a new passage summarization request.
 */
export function buildSummarizeMessage(selectedText) {
  return `Please summarize the following highlighted passage from the paper, situating it within the paper's argument:\n\n"${selectedText.trim()}"`;
}

// ── SSE stream reader (shared) ────────────────────────────────────────────────

async function* readSSE(response, extractChunk) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const json = t.slice(5).trim();
      if (json === "[DONE]") return;
      try {
        const chunk = extractChunk(JSON.parse(json));
        if (chunk) yield chunk;
      } catch { /* skip malformed line */ }
    }
  }
}

// ── Provider implementations ──────────────────────────────────────────────────

async function* streamGemini({ systemPrompt, messages, apiKey, model }) {
  const mdl = model || "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${mdl}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: {
        temperature: 0.25,
        maxOutputTokens: 1024,
        topP: 0.9,
      },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
      ],
    }),
  });

  if (!res.ok) {
    let msg = `Gemini error ${res.status}`;
    try { msg = JSON.parse(await res.text())?.error?.message || msg; } catch { /**/ }
    throw new Error(msg);
  }

  yield* readSSE(res, (p) => p?.candidates?.[0]?.content?.parts?.[0]?.text ?? "");
}

/** Handles all OpenAI-compatible endpoints: OpenAI, Mistral, DeepSeek, Local, Custom */
async function* streamOpenAICompat({ systemPrompt, messages, apiKey, endpoint, model }) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      temperature: 0.25,
      max_tokens: 1024,
      stream: true,
    }),
  });

  if (!res.ok) {
    let msg = `API error ${res.status} from ${endpoint}`;
    try { msg = JSON.parse(await res.text())?.error?.message || msg; } catch { /**/ }
    throw new Error(msg);
  }

  yield* readSSE(res, (p) => p?.choices?.[0]?.delta?.content ?? "");
}

async function* streamClaude({ systemPrompt, messages, apiKey, model }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: model || "claude-3-5-sonnet-20241022",
      system: systemPrompt,
      messages,
      max_tokens: 1024,
      stream: true,
    }),
  });

  if (!res.ok) {
    let msg = `Anthropic error ${res.status}`;
    try { msg = JSON.parse(await res.text())?.error?.message || msg; } catch { /**/ }
    throw new Error(msg);
  }

  yield* readSSE(res, (p) => (p?.type === "content_block_delta" ? (p?.delta?.text ?? "") : ""));
}

// ── Singleton ─────────────────────────────────────────────────────────────────

class AISummarizer {
  /**
   * Stream a response for the given conversation.
   *
   * @param {{
   *   systemPrompt: string,
   *   messages: {role: string, content: string}[]
   * }} opts
   */
  async *stream({ systemPrompt, messages }) {
    const key = keyManager.getKey();
    const provider = keyManager.getProvider();
    const endpoint = keyManager.getEndpoint();
    const model = keyManager.getModel();

    if (provider.requiresKey && !key) {
      throw new Error("No API key configured — click ✦ AI in the toolbar to add one.");
    }
    if (!messages?.length) throw new Error("No messages to send.");

    switch (provider.apiStyle) {
      case "gemini":
        yield* streamGemini({ systemPrompt, messages, apiKey: key, model });
        break;

      case "openai":
        // Covers: openai, mistral, deepseek, local, custom
        if (!endpoint) throw new Error("No endpoint configured — open ✦ AI settings and enter an endpoint URL.");
        yield* streamOpenAICompat({ systemPrompt, messages, apiKey: key, endpoint, model });
        break;

      case "claude":
        yield* streamClaude({ systemPrompt, messages, apiKey: key, model });
        break;

      default:
        throw new Error(`Unknown API style "${provider.apiStyle}" for provider "${provider.id}".`);
    }
  }
}

export const aiSummarizer = new AISummarizer();
