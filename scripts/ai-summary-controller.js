/**
 * ai-summary-controller.js  (v3)
 *
 * Wires AI tab, context-menu Summarize button, and full paper text extraction.
 * Uses a MutationObserver to deactivate the AI tab when reader.js switches
 * back to Comments/Notes — no changes to reader.js needed.
 */

import { keyManager }  from "./ai-key-manager.js";
import { summaryPanel } from "./ai-summary-panel.js";
import { getCurrentDocument } from "./store.js";

// How many pages to extract for the AI context (token budget guard)
const MAX_EXTRACT_PAGES = 30;
const MAX_EXTRACT_CHARS = 18000; // ~5-9k tokens depending on model

export class AISummaryController {
  /**
   * @param {import('./reader.js').ReaderController} reader
   * @param {Record<string, HTMLElement>} elements
   */
  constructor(reader, elements) {
    this._reader   = reader;
    this._elements = elements;
    this._textCache = new WeakMap(); // doc → extracted full text

    // Inject ✦ AI button in the topbar
    keyManager.injectSettingsButton();

    // Initialise the inline chat panel inside #ai-view
    summaryPanel.init(elements.aiView);

    // Wire the Summarize button in the right-click context menu
    elements.selectionSummarize?.addEventListener("click", () => this._onSummarizeClick());

    // Wire the AI tab click
    elements.tabAi.addEventListener("click", () => this._activateAiTab());

    // When reader.js internally shows Comments or Notes, deactivate AI tab
    // (e.g., focusComment() → setActiveTab("comments"))
    const obs = new MutationObserver(() => {
      const commentsVisible = !elements.commentsView.classList.contains("hidden");
      const notesVisible    = !elements.notesView.classList.contains("hidden");
      if (commentsVisible || notesVisible) {
        elements.tabAi.classList.remove("is-active");
        elements.aiView.classList.add("hidden");
      }
    });
    obs.observe(elements.commentsView, { attributes: true, attributeFilter: ["class"] });
    obs.observe(elements.notesView,    { attributes: true, attributeFilter: ["class"] });
  }

  // ── Tab management ──────────────────────────────────────────────────────────

  _activateAiTab() {
    const e = this._elements;
    e.tabComments.classList.remove("is-active");
    e.tabNotes.classList.remove("is-active");
    e.tabAi.classList.add("is-active");
    e.commentsView.classList.add("hidden");
    e.notesView.classList.add("hidden");
    e.aiView.classList.remove("hidden");
  }

  // ── Summarize flow ──────────────────────────────────────────────────────────

  async _onSummarizeClick() {
    const selection = this._reader.pendingSelection;
    if (!selection?.text) return;
    this._reader.hideSelectionMenu();

    if (!keyManager.isReady()) {
      keyManager.openModal(() => this._runSummarize(selection));
      return;
    }
    this._runSummarize(selection);
  }

  async _runSummarize(selection) {
    const doc = getCurrentDocument();

    // Build paper context — extract full text if not cached
    const fullText = doc ? await this._getFullText(doc) : "";

    const paperContext = {
      title:    doc?.title    || "",
      abstract: doc?.abstract || "",
      fullText,
    };

    // Switch to AI tab first so streaming is visible immediately
    this._activateAiTab();

    // Delegate to the panel
    summaryPanel.addSummary(selection.text, selection.pageNumber, paperContext);
  }

  // ── Full text extraction (cached per document) ───────────────────────────────

  async _getFullText(doc) {
    if (this._textCache.has(doc)) return this._textCache.get(doc);

    const pdfDoc   = doc.pdfDoc;
    const numPages = Math.min(pdfDoc.numPages, MAX_EXTRACT_PAGES);
    const chunks   = [];
    let totalChars = 0;

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      try {
        const page    = await pdfDoc.getPage(pageNum);
        const content = await page.getTextContent();
        let text = "";
        for (const item of content.items) {
          text += item.str || "";
          text += item.hasEOL ? "\n" : " ";
        }
        const clean = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
        if (!clean) continue;

        chunks.push(`[Page ${pageNum}]\n${clean}`);
        totalChars += clean.length;

        if (totalChars >= MAX_EXTRACT_CHARS) {
          chunks.push("[... remainder of document not included due to length ...]");
          break;
        }
      } catch {
        // skip pages that fail to render
      }
    }

    const fullText = chunks.join("\n\n");
    this._textCache.set(doc, fullText);
    return fullText;
  }
}
