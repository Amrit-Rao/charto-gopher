import { marked } from "https://cdn.jsdelivr.net/npm/marked/lib/marked.esm.js";
import { emit, getCurrentDocument, state } from "./store.js";

marked.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false });

export class ReaderController {
  constructor(elements, pdfjsLib) {
    this.elements = elements;
    this.pdfjsLib = pdfjsLib;
    this.pageStates = new Map();
    this.observer = null;
    this.notesSaveTimer = null;
    this.activeCommentId = null;
    this.pendingSelection = null;
    this.pendingHighlightWithComment = false;
    this.boundResize = this.debounce(() => this.handleResize(), 150);
    window.addEventListener("resize", this.boundResize);
    this.attachEvents();
  }

  attachEvents() {
    const e = this.elements;
    e.prevPage.addEventListener("click", () => this.scrollToPage((Number(e.currentPage.textContent) || 1) - 1));
    e.nextPage.addEventListener("click", () => this.scrollToPage((Number(e.currentPage.textContent) || 1) + 1));
    e.tabComments.addEventListener("click", () => this.setActiveTab("comments"));
    e.tabNotes.addEventListener("click", () => this.setActiveTab("notes"));
    e.notesTextarea.addEventListener("input", (event) => this.onNotesInput(event));
            e.saveComment.addEventListener("click", () => this.saveSelectionComment());
    e.cancelComment.addEventListener("click", () => this.closeCommentModal());
    e.closeModal.addEventListener("click", () => this.closeCommentModal());
    e.modal.addEventListener("click", (event) => { if (event.target === e.modal) this.closeCommentModal(); });
  }

  activate() {
    this.elements.readerPanel.classList.remove("hidden");
    this.elements.readerSidebar.classList.remove("hidden");
    this.render();
  }

  deactivate() {
    this.teardownPages();
        this.elements.readerPanel.classList.add("hidden");
    this.elements.readerSidebar.classList.add("hidden");
  }

  render() {
    const doc = getCurrentDocument();
    if (!doc) {
      this.renderEmpty();
      return;
    }
    this.elements.readerEmptyState.classList.add("hidden");
    this.elements.pdfContainer.classList.remove("hidden");
    this.elements.totalPages.textContent = String(doc.pdfDoc.numPages);
    this.elements.currentPage.textContent = String(doc.lastReaderPage || 1);
    this.renderCommentsList();
    this.updateNotesUI();
    this.buildPages(doc);
  }

  renderEmpty() {
    this.teardownPages();
    this.elements.readerEmptyState.classList.remove("hidden");
    this.elements.pdfContainer.classList.add("hidden");
    this.elements.currentPage.textContent = "0";
    this.elements.totalPages.textContent = "0";
    this.elements.commentsList.innerHTML = '<div class="placeholder-card">No comments yet.</div>';
    this.elements.notesPreview.innerHTML = '<div class="placeholder-card">Your rendered notes will appear here.</div>';
  }

  teardownPages() {
    clearTimeout(this.notesSaveTimer);
    if (this.observer) this.observer.disconnect();
    this.observer = null;
    this.pageStates.clear();
    this.elements.pdfContainer.innerHTML = "";
  }

  buildPages(doc) {
    this.teardownPages();
    const fragment = document.createDocumentFragment();
    this.observer = new IntersectionObserver((entries) => this.handlePageVisibility(entries), { root: this.elements.readerPanel, threshold: 0.3 });

    for (let pageNumber = 1; pageNumber <= doc.pdfDoc.numPages; pageNumber += 1) {
      const pageElement = document.createElement("article");
      pageElement.className = "pdf-page";
      pageElement.dataset.pageNumber = String(pageNumber);
      pageElement.innerHTML = `
        <div class="page-label">Page ${pageNumber}</div>
        <div class="page-shell">
          <canvas class="page-canvas"></canvas>
          <div class="text-layer"></div>
          <div class="highlight-layer"></div>
        </div>
      `;
      fragment.appendChild(pageElement);
      this.pageStates.set(pageNumber, {
        pageNumber,
        pageElement,
        canvas: pageElement.querySelector(".page-canvas"),
        textLayer: pageElement.querySelector(".text-layer"),
        highlightLayer: pageElement.querySelector(".highlight-layer"),
        rendered: false,
        renderTask: null,
      });
    }

    this.elements.pdfContainer.appendChild(fragment);
    this.elements.readerPanel.scrollTop = 0;
    for (const pageState of this.pageStates.values()) this.observer.observe(pageState.pageElement);
  }

  async handlePageVisibility(entries) {
    const doc = getCurrentDocument();
    if (!doc) return;
    for (const entry of entries) {
      const pageNumber = Number(entry.target.dataset.pageNumber);
      if (entry.isIntersecting) {
        doc.lastReaderPage = pageNumber;
        this.elements.currentPage.textContent = String(pageNumber);
      }
      const pageState = this.pageStates.get(pageNumber);
      if (!entry.isIntersecting || !pageState || pageState.rendered || pageState.renderTask) continue;
      pageState.renderTask = this.renderPage(doc, pageState);
      await pageState.renderTask;
      pageState.renderTask = null;
    }
  }

  async renderPage(doc, pageState) {
    const pdfPage = await doc.pdfDoc.getPage(pageState.pageNumber);
    const parentWidth = Math.min(pageState.pageElement.clientWidth - 36, 884);
    const initialViewport = pdfPage.getViewport({ scale: 1 });
    const scale = parentWidth / initialViewport.width;
    const viewport = pdfPage.getViewport({ scale });
    const pixelRatio = window.devicePixelRatio || 1;
    const canvas = pageState.canvas;
    const context = canvas.getContext("2d");
    canvas.width = Math.floor(viewport.width * pixelRatio);
    canvas.height = Math.floor(viewport.height * pixelRatio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    await pdfPage.render({ canvasContext: context, viewport }).promise;

    const textLayer = pageState.textLayer;
    textLayer.innerHTML = "";
    textLayer.style.width = `${viewport.width}px`;
    textLayer.style.height = `${viewport.height}px`;
    const textContent = await pdfPage.getTextContent();
    const task = this.pdfjsLib.renderTextLayer({ textContentSource: textContent, container: textLayer, viewport });
    await (task.promise || Promise.resolve());
    textLayer.addEventListener("mouseup", () => this.handleTextSelection(pageState));

    pageState.highlightLayer.style.width = `${viewport.width}px`;
    pageState.highlightLayer.style.height = `${viewport.height}px`;
    pageState.rendered = true;
    this.renderHighlightsForPage(pageState.pageNumber);
  }

  handleTextSelection(pageState) {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!pageState.textLayer.contains(range.commonAncestorContainer)) return;
    const rects = Array.from(range.getClientRects()).map((rect) => this.rectToRelative(rect, pageState.textLayer)).filter((rect) => rect.width > 0 && rect.height > 0);
    if (rects.length === 0) return;
    this.pendingSelection = {
      pageNumber: pageState.pageNumber,
      text: selection.toString().trim(),
      rects,
    };
    this.commitSelection(false);
  }

  showSelectionToolbar(x, y) {}

  hideSelectionToolbar() {}

  commitSelection(withComment) {
    const doc = getCurrentDocument();
    if (!doc || !this.pendingSelection) return;
    if (!doc.highlights) doc.highlights = [];
    const highlight = {
      id: crypto.randomUUID(),
      pageNumber: this.pendingSelection.pageNumber,
      text: this.pendingSelection.text,
      rects: this.pendingSelection.rects,
      commentId: null,
      createdAt: new Date().toISOString(),
    };
    doc.highlights.push(highlight);
    this.persistDocument(doc);
    this.renderHighlightsForPage(highlight.pageNumber);
    emit();
        window.getSelection()?.removeAllRanges();
    if (withComment) {
      this.pendingHighlightWithComment = highlight.id;
      this.elements.modalContext.textContent = `Page ${highlight.pageNumber} � ${highlight.text.slice(0, 120)}`;
      this.elements.commentInput.value = "";
      this.elements.modal.classList.remove("hidden");
    } else {
      this.pendingSelection = null;
    }
  }

  saveSelectionComment() {
    const doc = getCurrentDocument();
    const text = this.elements.commentInput.value.trim();
    if (!doc || !this.pendingHighlightWithComment || !text) {
      this.closeCommentModal();
      return;
    }
    const highlight = doc.highlights.find((item) => item.id === this.pendingHighlightWithComment);
    if (!highlight) {
      this.closeCommentModal();
      return;
    }
    const maxNumber = doc.comments.reduce((highest, comment) => Math.max(highest, Number(comment.number) || 0), 0);
    const comment = {
      id: crypto.randomUUID(),
      number: maxNumber + 1,
      ref: `C${maxNumber + 1}`,
      text,
      pageNumber: highlight.pageNumber,
      highlightId: highlight.id,
      textSelection: highlight.text,
      createdAt: new Date().toISOString(),
    };
    highlight.commentId = comment.id;
    doc.comments = [comment, ...doc.comments];
    this.activeCommentId = comment.id;
    this.persistDocument(doc);
    this.renderCommentsList();
    this.renderHighlightsForPage(highlight.pageNumber);
    this.renderNotesPreview();
    emit();
    this.closeCommentModal();
  }

  closeCommentModal() {
    this.pendingHighlightWithComment = null;
    this.pendingSelection = null;
    this.elements.modal.classList.add("hidden");
    window.getSelection()?.removeAllRanges();
  }

  renderHighlightsForPage(pageNumber) {
    const doc = getCurrentDocument();
    const pageState = this.pageStates.get(pageNumber);
    if (!doc || !pageState) return;
    pageState.highlightLayer.innerHTML = "";
    const highlights = (doc.highlights || []).filter((item) => item.pageNumber === pageNumber);
    for (const highlight of highlights) {
      const group = document.createElement("div");
      group.className = `highlight-group${highlight.commentId ? " has-comment" : ""}`;
      if (highlight.commentId === this.activeCommentId) group.classList.add("is-active");
      const comment = doc.comments.find((item) => item.id === highlight.commentId);
      highlight.rects.forEach((rect) => {
        const box = document.createElement("button");
        box.type = "button";
        box.className = "highlight-box";
        box.style.left = `${rect.x * 100}%`;
        box.style.top = `${rect.y * 100}%`;
        box.style.width = `${rect.width * 100}%`;
        box.style.height = `${rect.height * 100}%`;
        box.addEventListener("click", (event) => {
          event.stopPropagation();
          if (comment) {
            this.focusComment(comment.id);
          } else {
            this.pendingSelection = {
              pageNumber: highlight.pageNumber,
              text: highlight.text,
              rects: highlight.rects
            };
            this.pendingHighlightWithComment = highlight.id;
            this.elements.modalContext.textContent = `Page ${highlight.pageNumber} — ${highlight.text.slice(0, 120)}`;
            this.elements.commentInput.value = "";
            this.elements.modal.classList.remove("hidden");
          }
        });
        group.appendChild(box);
      });
      if (comment) {
        const popover = document.createElement("div");
        popover.className = "highlight-comment-popover";
        const firstRect = highlight.rects[0];
        popover.style.left = `${firstRect.x * 100}%`;
        popover.style.top = `${(firstRect.y + firstRect.height) * 100}%`;
        popover.innerHTML = `<strong>${comment.ref}</strong><div>${this.escapeHtml(comment.text)}</div>`;
        group.appendChild(popover);
      }
      pageState.highlightLayer.appendChild(group);
    }
  }

  renderCommentsList() {
    const doc = getCurrentDocument();
    if (!doc || doc.comments.length === 0) {
      this.elements.commentCount.textContent = "0 comments";
      this.elements.commentsList.innerHTML = '<div class="placeholder-card">No comments yet.</div>';
      return;
    }
    this.elements.commentCount.textContent = `${doc.comments.length} comment${doc.comments.length === 1 ? "" : "s"}`;
    const fragment = document.createDocumentFragment();
    doc.comments.forEach((comment) => {
      const card = document.createElement("article");
      card.className = "comment-card";
      if (comment.id === this.activeCommentId) card.classList.add("is-active");
      card.innerHTML = `
        <h3><span class="comment-tag">${comment.ref}</span><span>Page ${comment.pageNumber}</span></h3>
        <p>${this.escapeHtml(comment.text)}</p>
        <small>${this.escapeHtml(comment.textSelection || "")}</small>
      `;
      card.addEventListener("click", () => this.focusComment(comment.id));
      fragment.appendChild(card);
    });
    this.elements.commentsList.innerHTML = "";
    this.elements.commentsList.appendChild(fragment);
  }

  focusComment(commentId) {
    const doc = getCurrentDocument();
    if (!doc) return;
    const comment = doc.comments.find((item) => item.id === commentId);
    if (!comment) return;
    this.activeCommentId = comment.id;
    this.setActiveTab("comments");
    this.renderCommentsList();
    this.renderHighlightsForPage(comment.pageNumber);
    this.scrollToPage(comment.pageNumber);
  }

  scrollToPage(pageNumber) {
    const pageState = this.pageStates.get(pageNumber);
    if (!pageState) return;
    this.elements.readerPanel.scrollTo({ top: pageState.pageElement.offsetTop - 12, behavior: "smooth" });
  }

  setActiveTab(tab) {
    const commentsActive = tab === "comments";
    this.elements.tabComments.classList.toggle("is-active", commentsActive);
    this.elements.tabNotes.classList.toggle("is-active", !commentsActive);
    this.elements.commentsView.classList.toggle("hidden", !commentsActive);
    this.elements.notesView.classList.toggle("hidden", commentsActive);
  }

  onNotesInput(event) {
    const doc = getCurrentDocument();
    if (!doc) return;
    doc.notes = event.target.value;
    this.renderNotesPreview();
    clearTimeout(this.notesSaveTimer);
    this.notesSaveTimer = window.setTimeout(() => {
      this.persistDocument(doc);
      emit();
    }, 250);
  }

  updateNotesUI() {
    const doc = getCurrentDocument();
    if (!doc) return;
    this.elements.notesTextarea.value = doc.notes || "";
    this.renderNotesPreview();
  }

  renderNotesPreview() {
    const doc = getCurrentDocument();
    if (!doc || !doc.notes?.trim()) {
      this.elements.notesPreview.innerHTML = '<div class="placeholder-card">Your rendered notes will appear here.</div>';
      return;
    }
    const html = marked.parse(doc.notes);
    const withRefs = html.replace(/\[\[(C\d+)\]\]/g, (match, ref) => {
      const comment = doc.comments.find((item) => item.ref === ref);
      return comment ? `<button type="button" class="comment-ref" data-comment-id="${comment.id}">${ref}</button>` : `<span class="comment-ref">${ref}</span>`;
    });
    this.elements.notesPreview.innerHTML = withRefs;
    this.elements.notesPreview.querySelectorAll(".comment-ref[data-comment-id]").forEach((node) => {
      node.addEventListener("click", () => this.focusComment(node.getAttribute("data-comment-id")));
    });
  }

  persistDocument(doc) {
    localStorage.setItem(`comments:${doc.key}`, JSON.stringify(doc.comments || []));
    localStorage.setItem(`notes:${doc.key}`, doc.notes || "");
    localStorage.setItem(`highlights:${doc.key}`, JSON.stringify(doc.highlights || []));
  }

  async handleResize() {
    if (state.mode !== "reader") return;
    const doc = getCurrentDocument();
    if (!doc) return;
    for (const pageState of this.pageStates.values()) {
      pageState.rendered = false;
      await this.renderPage(doc, pageState);
    }
  }

  rectToRelative(rect, container) {
    const bounds = container.getBoundingClientRect();
    return {
      x: (rect.left - bounds.left) / bounds.width,
      y: (rect.top - bounds.top) / bounds.height,
      width: rect.width / bounds.width,
      height: rect.height / bounds.height,
    };
  }

  escapeHtml(text) {
    return String(text || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  }

  debounce(fn, wait) {
    let timeoutId = null;
    return (...args) => { clearTimeout(timeoutId); timeoutId = window.setTimeout(() => fn(...args), wait); };
  }
}
