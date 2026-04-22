/**
 * ai-summary-panel.js  (v2 — inline sidebar chat)
 *
 * Renders a chat thread directly inside the #ai-view sidebar section.
 * Supports:
 *   - Quoted passage bubbles when triggered by right-click → Summarize
 *   - Streaming AI response bubbles
 *   - Follow-up free-text questions (full multi-turn conversation history)
 *   - Copy and Add-to-Notes actions per response
 */

import { keyManager }                              from "./ai-key-manager.js";
import { aiSummarizer, buildSystemPrompt, buildSummarizeMessage } from "./ai-summarizer.js";

class SummaryPanel {
  constructor() {
    this._container          = null; // #ai-view element
    this._chatEl             = null; // scrollable thread div
    this._inputEl            = null; // follow-up textarea
    this._sendBtn            = null;
    this._paperContext       = { title: "", abstract: "" };
    this._conversationHistory = [];  // [{role:'user'|'assistant', content:string}]
    this._isStreaming        = false;
    this._toast              = null;
  }

  /** Called once by the controller to wire up the #ai-view element. */
  init(aiViewEl) {
    this._container = aiViewEl;
    this._buildUI();
    this._buildToast();
  }

  // ── DOM construction ────────────────────────────────────────────────────────

  _buildUI() {
    this._container.innerHTML = `
      <div class="ai-chat-header">
        <div class="ai-chat-header-left">
          <span class="ai-panel-eyebrow">AI Chat</span>
          <span class="ai-chat-provider-tag none" id="ai-chat-provider-tag">No key</span>
        </div>
        <button class="ai-chat-clear-btn" id="ai-chat-clear" type="button" title="Clear conversation">
          ↺ Clear
        </button>
      </div>

      <div class="ai-chat-thread" id="ai-chat-thread">
        <div class="ai-chat-empty" id="ai-chat-empty">
          <div class="ai-chat-empty-icon">✦</div>
          <p>Select text in the PDF, right‑click, and choose <strong>Summarize</strong>.</p>
          <p class="muted small-copy">You can then ask follow‑up questions below.</p>
        </div>
      </div>

      <div class="ai-chat-input-area">
        <textarea
          id="ai-chat-input"
          class="ai-chat-input"
          placeholder="Ask a follow-up question about this paper…"
          rows="2"
        ></textarea>
        <button id="ai-chat-send" class="ai-chat-send-btn" type="button" aria-label="Send message">→</button>
      </div>
    `;

    this._chatEl  = this._container.querySelector("#ai-chat-thread");
    this._inputEl = this._container.querySelector("#ai-chat-input");
    this._sendBtn = this._container.querySelector("#ai-chat-send");

    this._container.querySelector("#ai-chat-clear")
      .addEventListener("click", () => this.clearChat());

    this._sendBtn.addEventListener("click", () => this._sendFollowUp());

    this._inputEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        this._sendFollowUp();
      }
    });

    this._updateProviderTag();
    keyManager.onChange(() => this._updateProviderTag());
  }

  _buildToast() {
    if (document.getElementById("ai-toast")) {
      this._toast = document.getElementById("ai-toast");
      return;
    }
    const toast = document.createElement("div");
    toast.className = "ai-toast";
    toast.id = "ai-toast";
    document.body.appendChild(toast);
    this._toast = toast;
  }

  _updateProviderTag() {
    const tag = this._container?.querySelector("#ai-chat-provider-tag");
    if (!tag) return;
    const provider = keyManager.getProvider();
    const ready    = keyManager.isReady();
    tag.textContent = ready ? provider.name : "No key";
    tag.className   = `ai-chat-provider-tag ${ready ? provider.id : "none"}`;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  clearChat() {
    this._conversationHistory = [];
    this._chatEl.innerHTML = `
      <div class="ai-chat-empty" id="ai-chat-empty">
        <div class="ai-chat-empty-icon">✦</div>
        <p>Select text in the PDF, right‑click, and choose <strong>Summarize</strong>.</p>
        <p class="muted small-copy">You can then ask follow‑up questions below.</p>
      </div>`;
  }

  /**
   * Add a new summarization request from a text selection.
   * Called by the controller when the user clicks "Summarize".
   */
  async addSummary(selectedText, pageNumber, paperContext) {
    this._paperContext = paperContext;
    this._hideEmpty();

    // Quote bubble
    this._appendQuoteBubble(selectedText, pageNumber);

    // Build the initial summarize message and push to history
    const userMessage = buildSummarizeMessage(selectedText);
    this._conversationHistory.push({ role: "user", content: userMessage });

    // Stream AI response into an assistant bubble
    const systemPrompt = buildSystemPrompt(paperContext);
    await this._streamNewBubble(systemPrompt, selectedText);
  }

  // ── Private: Follow-up ──────────────────────────────────────────────────────

  async _sendFollowUp() {
    if (this._isStreaming) return;
    const question = this._inputEl.value.trim();
    if (!question) return;

    if (!keyManager.isReady()) {
      keyManager.openModal();
      return;
    }

    this._inputEl.value = "";
    this._hideEmpty();

    // Render user follow-up bubble
    this._appendUserBubble(question);
    this._conversationHistory.push({ role: "user", content: question });

    const systemPrompt = buildSystemPrompt(this._paperContext);
    await this._streamNewBubble(systemPrompt, null);
  }

  // ── Private: Streaming ──────────────────────────────────────────────────────

  async _streamNewBubble(systemPrompt, quoteText) {
    this._isStreaming    = true;
    this._sendBtn.disabled = true;

    const { bubble, textEl, actionsEl } = this._appendAIBubble();
    let accumulated = "";

    try {
      const gen = aiSummarizer.stream({
        systemPrompt,
        messages: [...this._conversationHistory],
      });

      let firstChunk = true;
      for await (const chunk of gen) {
        if (firstChunk) {
          bubble.querySelector(".ai-bubble-spinner")?.remove();
          firstChunk = false;
        }
        accumulated += chunk;
        textEl.textContent = accumulated;
        this._scrollChatBottom();
      }

      // No chunks at all
      if (firstChunk) {
        bubble.querySelector(".ai-bubble-spinner")?.remove();
        textEl.textContent = "(No response received — try again.)";
      }
    } catch (err) {
      bubble.querySelector(".ai-bubble-spinner")?.remove();
      textEl.innerHTML = `<span class="ai-bubble-error">⚠ ${this._escHtml(err.message)}</span>`;
    } finally {
      this._isStreaming = false;
      this._sendBtn.disabled = false;
    }

    // Save to history and enable action buttons
    if (accumulated) {
      this._conversationHistory.push({ role: "assistant", content: accumulated });
      actionsEl.classList.remove("hidden");

      const copyBtn  = actionsEl.querySelector("[data-action='copy']");
      const notesBtn = actionsEl.querySelector("[data-action='notes']");
      if (copyBtn)  copyBtn.addEventListener("click",  () => { this._copyText(accumulated); this._showToast("Summary copied!"); });
      if (notesBtn) notesBtn.addEventListener("click",  () => this._appendToNotes(accumulated, quoteText || ""));
    }
  }

  // ── Private: Bubble builders ────────────────────────────────────────────────

  _appendQuoteBubble(text, pageNumber) {
    const el = document.createElement("div");
    el.className = "ai-chat-bubble ai-bubble-quote";
    el.innerHTML = `
      <div class="ai-bubble-meta">
        <span class="ai-bubble-page-icon">📄</span>
        <span>${pageNumber ? `Page ${pageNumber}` : "Selection"}</span>
      </div>
      <blockquote class="ai-bubble-quote-text">${this._escHtml(text)}</blockquote>
    `;
    this._chatEl.appendChild(el);
    this._scrollChatBottom();
    return el;
  }

  _appendUserBubble(text) {
    const el = document.createElement("div");
    el.className = "ai-chat-bubble ai-bubble-user";
    el.innerHTML = `
      <div class="ai-bubble-meta">
        <span class="ai-bubble-you">You</span>
      </div>
      <div class="ai-bubble-text">${this._escHtml(text)}</div>
    `;
    this._chatEl.appendChild(el);
    this._scrollChatBottom();
    return el;
  }

  _appendAIBubble() {
    const provider = keyManager.getProvider();
    const el = document.createElement("div");
    el.className = "ai-chat-bubble ai-bubble-assistant";
    el.innerHTML = `
      <div class="ai-bubble-meta">
        <span class="ai-bubble-sparkle">✦</span>
        <span class="ai-bubble-provider-name">${this._escHtml(provider.name)}</span>
      </div>
      <div class="ai-bubble-spinner"><div class="ai-spinner"></div><span>Thinking…</span></div>
      <div class="ai-bubble-text"></div>
      <div class="ai-bubble-actions hidden">
        <button class="ai-inline-btn" data-action="copy"  type="button">⎘ Copy</button>
        <button class="ai-inline-btn" data-action="notes" type="button">✎ Add to Notes</button>
      </div>
    `;
    this._chatEl.appendChild(el);
    this._scrollChatBottom();
    return {
      bubble:    el,
      textEl:    el.querySelector(".ai-bubble-text"),
      actionsEl: el.querySelector(".ai-bubble-actions"),
    };
  }

  // ── Private: Utilities ──────────────────────────────────────────────────────

  _hideEmpty() {
    this._chatEl.querySelector("#ai-chat-empty")?.remove();
  }

  _scrollChatBottom() {
    requestAnimationFrame(() => {
      this._chatEl.scrollTop = this._chatEl.scrollHeight;
    });
  }

  _appendToNotes(summary, quote) {
    const textarea = document.getElementById("notes-textarea");
    if (!textarea) { this._showToast("Notes panel not found."); return; }
    const quotePart   = quote ? `> ${quote.replace(/\n/g, "\n> ")}\n\n` : "";
    const summaryPart = `**AI Summary:** ${summary}`;
    textarea.value += `\n---\n${quotePart}${summaryPart}\n`;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("tab-notes")?.click();
    this._showToast("Summary added to Notes ✓");
  }

  async _copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
  }

  _showToast(message) {
    if (!this._toast) return;
    this._toast.textContent = message;
    this._toast.classList.add("is-visible");
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this._toast.classList.remove("is-visible"), 2400);
  }

  _escHtml(text) {
    return String(text || "")
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }
}

export const summaryPanel = new SummaryPanel();
