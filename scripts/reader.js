import { marked } from "https://cdn.jsdelivr.net/npm/marked/lib/marked.esm.js";
import { emit, getCurrentDocument, state } from "./store.js";

marked.setOptions({
  gfm: true,
  breaks: true,
  headerIds: false,
  mangle: false,
});

export class ReaderController {
  constructor(elements, pdfjsLib) {
    this.elements = elements;
    this.pdfjsLib = pdfjsLib;
    this.pageStates = new Map();
    this.observer = null;
    this.notesSaveTimer = null;
    this.activeCommentId = null;
    this.pendingSelection = null;
    this.pendingHighlightId = null;
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
    e.selectionCopy.addEventListener("click", () => this.copyPendingSelection());
    e.selectionHighlight.addEventListener("click", () => this.commitSelection(false));
    e.selectionHighlightComment.addEventListener("click", () => this.commitSelection(true));
    e.saveComment.addEventListener("click", () => this.saveSelectionComment());
    e.cancelComment.addEventListener("click", () => this.closeCommentModal());
    e.closeModal.addEventListener("click", () => this.closeCommentModal());
    e.modal.addEventListener("click", (event) => {
      if (event.target === e.modal) {
        this.closeCommentModal();
      }
    });

    document.addEventListener("click", (event) => {
      if (!e.selectionContextMenu.contains(event.target)) {
        this.hideSelectionMenu();
      }
      const insideCommentUi = event.target instanceof Element
        && event.target.closest(".highlight-box, .highlight-comment-marker, .highlight-comment-popover, .comment-card, .comment-ref");
      if (!insideCommentUi) {
        this.clearActiveComment();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.hideSelectionMenu();
        this.closeCommentModal();
        this.clearActiveComment();
      }
    });
  }

  activate() {
    this.elements.readerPanel.classList.remove("hidden");
    this.elements.readerSidebar.classList.remove("hidden");
    this.render();
  }

  deactivate() {
    this.teardownPages();
    this.hideSelectionMenu();
    this.elements.readerPanel.classList.add("hidden");
    this.elements.readerSidebar.classList.add("hidden");
  }

  render() {
    const doc = getCurrentDocument();
    if (!doc) {
      this.renderEmpty();
      return;
    }

    if (this.activeCommentId && !(doc.comments || []).some((comment) => comment.id === this.activeCommentId)) {
      this.activeCommentId = null;
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
    this.elements.commentCount.textContent = "0 comments";
    this.elements.commentsList.innerHTML = '<div class="placeholder-card">No comments yet.</div>';
    this.elements.notesPreview.innerHTML = '<div class="placeholder-card">Your rendered notes will appear here.</div>';
  }

  teardownPages() {
    clearTimeout(this.notesSaveTimer);
    if (this.observer) {
      this.observer.disconnect();
    }
    this.observer = null;
    this.pageStates.clear();
    this.elements.pdfContainer.innerHTML = "";
  }

  buildPages(doc) {
    this.teardownPages();
    const fragment = document.createDocumentFragment();
    this.observer = new IntersectionObserver((entries) => this.handlePageVisibility(entries), {
      root: this.elements.readerPanel,
      threshold: 0.05,
      rootMargin: "200px 0px",
    });

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
        pageShell: pageElement.querySelector(".page-shell"),
        canvas: pageElement.querySelector(".page-canvas"),
        textLayer: pageElement.querySelector(".text-layer"),
        highlightLayer: pageElement.querySelector(".highlight-layer"),
        rendered: false,
        renderTask: null,
        eventsBound: false,
      });
    }

    this.elements.pdfContainer.appendChild(fragment);
    this.elements.readerPanel.scrollTop = 0;
    for (const pageState of this.pageStates.values()) {
      this.observer.observe(pageState.pageElement);
    }

    this.ensurePageRendered(doc, doc.lastReaderPage || 1);
    this.ensurePageRendered(doc, Math.min((doc.lastReaderPage || 1) + 1, doc.pdfDoc.numPages));
  }

  async handlePageVisibility(entries) {
    const doc = getCurrentDocument();
    if (!doc) {
      return;
    }

    for (const entry of entries) {
      const pageNumber = Number(entry.target.dataset.pageNumber);
      if (entry.isIntersecting) {
        doc.lastReaderPage = pageNumber;
        this.elements.currentPage.textContent = String(pageNumber);
      }
      if (entry.isIntersecting) {
        this.ensurePageRendered(doc, pageNumber);
      }
    }
  }

  ensurePageRendered(doc, pageNumber) {
    const pageState = this.pageStates.get(pageNumber);
    if (!pageState || pageState.rendered || pageState.renderTask) {
      return;
    }
    pageState.renderTask = this.renderPage(doc, pageState).finally(() => {
      pageState.renderTask = null;
    });
  }

  async renderPage(doc, pageState) {
    const pdfPage = await doc.pdfDoc.getPage(pageState.pageNumber);
    const maxWidth = Math.min(pageState.pageElement.clientWidth - 40, 980);
    const initialViewport = pdfPage.getViewport({ scale: 1 });
    const scale = maxWidth / initialViewport.width;
    const viewport = pdfPage.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;

    pageState.pageShell.style.width = `${viewport.width}px`;
    pageState.pageShell.style.height = `${viewport.height}px`;

    const canvas = pageState.canvas;
    const context = canvas.getContext("2d");
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    await pdfPage.render({
      canvasContext: context,
      viewport,
    }).promise;

    const textLayer = pageState.textLayer;
    textLayer.innerHTML = "";
    textLayer.style.width = `${viewport.width}px`;
    textLayer.style.height = `${viewport.height}px`;

    const textContent = await pdfPage.getTextContent();
    if (this.pdfjsLib.TextLayer) {
      const textLayerBuilder = new this.pdfjsLib.TextLayer({
        container: textLayer,
        textContentSource: textContent,
        viewport,
      });
      await textLayerBuilder.render();
    } else {
      const task = this.pdfjsLib.renderTextLayer({
        textContentSource: textContent,
        container: textLayer,
        viewport,
        enhanceTextSelection: true,
      });
      if (task?.promise) {
        await task.promise;
      }
    }

    pageState.highlightLayer.style.width = `${viewport.width}px`;
    pageState.highlightLayer.style.height = `${viewport.height}px`;
    pageState.rendered = true;
    this.bindPageEvents(pageState);
    this.renderHighlightsForPage(pageState.pageNumber);
  }

  bindPageEvents(pageState) {
    if (pageState.eventsBound) {
      return;
    }
    pageState.eventsBound = true;

    pageState.textLayer.addEventListener("contextmenu", (event) => {
      const selection = this.captureSelection(pageState);
      if (!selection) {
        this.hideSelectionMenu();
        return;
      }
      event.preventDefault();
      this.pendingSelection = selection;
      this.showSelectionMenu(event.clientX, event.clientY);
    });
  }

  captureSelection(pageState) {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return null;
    }

    const range = selection.getRangeAt(0);
    if (!pageState.textLayer.contains(range.commonAncestorContainer)) {
      return null;
    }

    const text = selection.toString().replace(/\s+/g, " ").trim();
    if (!text) {
      return null;
    }

    const rects = this.getSelectionRects(range, pageState);

    if (rects.length === 0) {
      return null;
    }

    return {
      pageNumber: pageState.pageNumber,
      text,
      rects,
    };
  }

  showSelectionMenu(clientX, clientY) {
    const menu = this.elements.selectionContextMenu;
    menu.classList.remove("hidden");
    menu.setAttribute("aria-hidden", "false");

    const { innerWidth, innerHeight } = window;
    const clampedX = Math.min(clientX, innerWidth - menu.offsetWidth - 16);
    const clampedY = Math.min(clientY, innerHeight - menu.offsetHeight - 16);
    menu.style.left = `${Math.max(16, clampedX)}px`;
    menu.style.top = `${Math.max(16, clampedY)}px`;
  }

  hideSelectionMenu() {
    this.elements.selectionContextMenu.classList.add("hidden");
    this.elements.selectionContextMenu.setAttribute("aria-hidden", "true");
  }

  async copyPendingSelection() {
    if (!this.pendingSelection?.text) {
      return;
    }
    await this.copyText(this.pendingSelection.text);
    this.hideSelectionMenu();
  }

  commitSelection(openComment) {
    const doc = getCurrentDocument();
    if (!doc || !this.pendingSelection) {
      return;
    }

    if (!doc.highlights) {
      doc.highlights = [];
    }

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
    this.hideSelectionMenu();

    if (openComment) {
      this.pendingHighlightId = highlight.id;
      this.elements.modalContext.textContent = `Page ${highlight.pageNumber}: ${highlight.text.slice(0, 120)}`;
      this.elements.commentInput.value = "";
      this.elements.modal.classList.remove("hidden");
      this.elements.modal.setAttribute("aria-hidden", "false");
      window.getSelection()?.removeAllRanges();
      this.elements.commentInput.focus();
    } else {
      this.pendingSelection = null;
      window.getSelection()?.removeAllRanges();
    }
  }

  saveSelectionComment() {
    const doc = getCurrentDocument();
    const text = this.elements.commentInput.value.trim();
    if (!doc || !this.pendingHighlightId || !text) {
      this.closeCommentModal();
      return;
    }

    const highlight = doc.highlights.find((item) => item.id === this.pendingHighlightId);
    if (!highlight) {
      this.closeCommentModal();
      return;
    }

    const maxNumber = (doc.comments || []).reduce((highest, comment) => Math.max(highest, Number(comment.number) || 0), 0);
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
    doc.comments = [comment, ...(doc.comments || [])];
    this.activeCommentId = comment.id;
    this.persistDocument(doc);
    this.renderCommentsList();
    this.renderHighlightsForPage(highlight.pageNumber);
    this.renderNotesPreview();
    emit();
    this.closeCommentModal();
  }

  closeCommentModal() {
    this.pendingHighlightId = null;
    this.pendingSelection = null;
    this.elements.modal.classList.add("hidden");
    this.elements.modal.setAttribute("aria-hidden", "true");
    this.hideSelectionMenu();
    window.getSelection()?.removeAllRanges();
  }

  renderHighlightsForPage(pageNumber) {
    const doc = getCurrentDocument();
    const pageState = this.pageStates.get(pageNumber);
    if (!doc || !pageState || !pageState.rendered) {
      return;
    }

    pageState.highlightLayer.innerHTML = "";
    const highlights = (doc.highlights || []).filter((item) => item.pageNumber === pageNumber);
    for (const highlight of highlights) {
      const group = document.createElement("div");
      group.className = `highlight-group${highlight.commentId ? " has-comment" : ""}${highlight.commentId === this.activeCommentId ? " is-active" : ""}`;
      const anchorRect = this.getAnchorRect(highlight.rects);

      for (const rect of highlight.rects) {
        const box = document.createElement("button");
        box.type = "button";
        box.className = "highlight-box";
        box.style.left = `${rect.x * 100}%`;
        box.style.top = `${rect.y * 100}%`;
        box.style.width = `${rect.width * 100}%`;
        box.style.height = `${rect.height * 100}%`;
        if (highlight.commentId) {
          box.addEventListener("click", (event) => {
            event.stopPropagation();
            this.focusComment(highlight.commentId);
          });
        }
        group.appendChild(box);
      }

      if (highlight.commentId) {
        const comment = (doc.comments || []).find((item) => item.id === highlight.commentId);
        if (comment) {
          const marker = document.createElement("button");
          marker.type = "button";
          marker.className = "highlight-comment-marker";
          marker.textContent = comment.ref;
          marker.setAttribute("aria-label", `Open comment ${comment.ref}`);
          const markerPosition = this.getCommentMarkerPosition(anchorRect, pageState);
          marker.style.left = `${markerPosition.left}px`;
          marker.style.top = `${markerPosition.top}px`;
          marker.addEventListener("click", (event) => {
            event.stopPropagation();
            this.focusComment(comment.id);
          });
          group.appendChild(marker);

          const popover = document.createElement("div");
          popover.className = "highlight-comment-popover";
          const popoverPosition = this.getCommentPopoverPosition(anchorRect, pageState);
          popover.style.left = `${popoverPosition.left}px`;
          popover.style.top = `${popoverPosition.top}px`;
          popover.classList.toggle("is-above", popoverPosition.placement === "top");
          popover.innerHTML = `
            <div class="highlight-comment-header">
              <strong>${comment.ref}</strong>
              <button type="button" class="highlight-comment-close" aria-label="Close comment preview">x</button>
            </div>
            <div class="highlight-comment-body">${this.escapeHtml(comment.text)}</div>
            ${comment.textSelection ? `<div class="highlight-comment-quote">${this.escapeHtml(comment.textSelection)}</div>` : ""}
          `;
          popover.querySelector(".highlight-comment-close")?.addEventListener("click", (event) => {
            event.stopPropagation();
            this.clearActiveComment();
          });
          popover.addEventListener("click", (event) => {
            event.stopPropagation();
            this.focusComment(comment.id);
          });
          group.appendChild(popover);
        }
      }

      pageState.highlightLayer.appendChild(group);
    }
  }

  renderCommentsList() {
    const doc = getCurrentDocument();
    if (!doc || !doc.comments || doc.comments.length === 0) {
      this.elements.commentCount.textContent = "0 comments";
      this.elements.commentsList.innerHTML = '<div class="placeholder-card">No comments yet.</div>';
      return;
    }

    this.elements.commentCount.textContent = `${doc.comments.length} comment${doc.comments.length === 1 ? "" : "s"}`;
    const fragment = document.createDocumentFragment();
    for (const comment of doc.comments) {
      const card = document.createElement("article");
      card.className = `comment-card${comment.id === this.activeCommentId ? " is-active" : ""}`;
      card.innerHTML = `
        <h3><span class="comment-tag">${comment.ref}</span><span>Page ${comment.pageNumber}</span></h3>
        <p>${this.escapeHtml(comment.text)}</p>
        <small>${this.escapeHtml(comment.textSelection || "")}</small>
        <div class="comment-card-actions">
          <button type="button" data-copy-quote>Copy quote</button>
          <button type="button" data-copy-comment>Copy comment</button>
        </div>
      `;
      card.addEventListener("click", () => this.focusComment(comment.id));

      card.querySelector("[data-copy-quote]").addEventListener("click", async (event) => {
        event.stopPropagation();
        await this.copyText(comment.textSelection || "");
      });
      card.querySelector("[data-copy-comment]").addEventListener("click", async (event) => {
        event.stopPropagation();
        await this.copyText(comment.text);
      });

      fragment.appendChild(card);
    }

    this.elements.commentsList.innerHTML = "";
    this.elements.commentsList.appendChild(fragment);
  }

  focusComment(commentId) {
    const doc = getCurrentDocument();
    if (!doc) {
      return;
    }

    const comment = doc.comments.find((item) => item.id === commentId);
    if (!comment) {
      return;
    }

    this.activeCommentId = comment.id;
    this.setActiveTab("comments");
    this.renderCommentsList();
    for (const pageState of this.pageStates.values()) {
      this.renderHighlightsForPage(pageState.pageNumber);
    }
    this.scrollToPage(comment.pageNumber);
    requestAnimationFrame(() => {
      this.elements.commentsList.querySelector(".comment-card.is-active")?.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    });
  }

  clearActiveComment() {
    if (!this.activeCommentId) {
      return;
    }

    this.activeCommentId = null;
    this.renderCommentsList();
    for (const pageState of this.pageStates.values()) {
      this.renderHighlightsForPage(pageState.pageNumber);
    }
  }

  scrollToPage(pageNumber) {
    const pageState = this.pageStates.get(pageNumber);
    if (!pageState) {
      return;
    }
    this.elements.readerPanel.scrollTo({
      top: pageState.pageElement.offsetTop - 12,
      behavior: "smooth",
    });
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
    if (!doc) {
      return;
    }

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
    if (!doc) {
      return;
    }
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
      const comment = (doc.comments || []).find((item) => item.ref === ref);
      if (!comment) {
        return `<span class="comment-ref">${ref}</span>`;
      }
      return `<button type="button" class="comment-ref" data-comment-id="${comment.id}">${ref}</button>`;
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
    if (state.mode !== "reader") {
      return;
    }

    const doc = getCurrentDocument();
    if (!doc) {
      return;
    }

    for (const pageState of this.pageStates.values()) {
      pageState.rendered = false;
      this.ensurePageRendered(doc, pageState.pageNumber);
    }
  }

  rectToRelative(rect, container) {
    const bounds = container.getBoundingClientRect();
    const left = (rect.left - bounds.left) / bounds.width;
    const top = (rect.top - bounds.top) / bounds.height;
    const right = (rect.right - bounds.left) / bounds.width;
    const bottom = (rect.bottom - bounds.top) / bounds.height;
    return {
      x: this.clamp01(left),
      y: this.clamp01(top),
      width: Math.max(0, this.clamp01(right) - this.clamp01(left)),
      height: Math.max(0, this.clamp01(bottom) - this.clamp01(top)),
    };
  }

  getSelectionRects(range, pageState) {
    const rawRects = Array.from(range.getClientRects())
      .map((rect) => this.rectToRelative(rect, pageState.pageShell))
      .filter((rect) => rect.width > 0.001 && rect.height > 0.001);
    const normalizedRaw = this.normalizeRelativeRects(rawRects);
    const normalizedSpanRects = this.collectIntersectingSpanRects(range, pageState);

    if (this.shouldPreferSpanRects(normalizedRaw, normalizedSpanRects)) {
      return normalizedSpanRects;
    }

    return normalizedRaw.length ? normalizedRaw : normalizedSpanRects;
  }

  collectIntersectingSpanRects(range, pageState) {
    const spanRects = [];
    const spans = pageState.textLayer.querySelectorAll("span");
    for (const span of spans) {
      if (!span.textContent?.trim()) {
        continue;
      }

      try {
        if (!range.intersectsNode(span)) {
          continue;
        }
      } catch {
        continue;
      }

      const rect = this.rectToRelative(span.getBoundingClientRect(), pageState.pageShell);
      if (rect.width > 0.001 && rect.height > 0.001) {
        spanRects.push(rect);
      }
    }

    return this.normalizeRelativeRects(spanRects);
  }

  shouldPreferSpanRects(rawRects, spanRects) {
    if (rawRects.length === 0) {
      return spanRects.length > 0;
    }
    if (spanRects.length === 0) {
      return false;
    }

    const rawArea = rawRects.reduce((total, rect) => total + (rect.width * rect.height), 0);
    const spanArea = spanRects.reduce((total, rect) => total + (rect.width * rect.height), 0);
    const rawMaxWidth = Math.max(...rawRects.map((rect) => rect.width));
    const spanMaxWidth = Math.max(...spanRects.map((rect) => rect.width));

    return rawArea > spanArea * 1.45 || (rawMaxWidth > 0.82 && spanMaxWidth < rawMaxWidth * 0.78);
  }

  normalizeRelativeRects(rects) {
    const sortedRects = rects
      .map((rect) => ({
        x: this.clamp01(rect.x),
        y: this.clamp01(rect.y),
        width: Math.max(0, Math.min(1 - this.clamp01(rect.x), rect.width)),
        height: Math.max(0, Math.min(1 - this.clamp01(rect.y), rect.height)),
      }))
      .filter((rect) => rect.width > 0.001 && rect.height > 0.001)
      .sort((left, right) => {
        if (Math.abs(left.y - right.y) > 0.002) {
          return left.y - right.y;
        }
        return left.x - right.x;
      });

    const merged = [];
    for (const rect of sortedRects) {
      const previous = merged[merged.length - 1];
      if (previous && this.isSameTextLine(previous, rect) && rect.x <= previous.x + previous.width + 0.012) {
        const rightEdge = Math.max(previous.x + previous.width, rect.x + rect.width);
        previous.x = Math.min(previous.x, rect.x);
        previous.y = Math.min(previous.y, rect.y);
        previous.height = Math.max(previous.height, rect.height);
        previous.width = rightEdge - previous.x;
        continue;
      }

      if (previous && this.rectContains(previous, rect)) {
        continue;
      }

      merged.push({ ...rect });
    }

    return merged;
  }

  isSameTextLine(left, right) {
    const leftCenter = left.y + (left.height / 2);
    const rightCenter = right.y + (right.height / 2);
    return Math.abs(leftCenter - rightCenter) <= Math.max(left.height, right.height) * 0.7;
  }

  rectContains(outer, inner) {
    return inner.x >= outer.x
      && inner.y >= outer.y
      && inner.x + inner.width <= outer.x + outer.width
      && inner.y + inner.height <= outer.y + outer.height;
  }

  getAnchorRect(rects) {
    return [...rects].sort((left, right) => {
      if (Math.abs(left.y - right.y) > 0.002) {
        return left.y - right.y;
      }
      return left.x - right.x;
    })[0];
  }

  getCommentMarkerPosition(rect, pageState) {
    const shellWidth = pageState.pageShell.clientWidth;
    const shellHeight = pageState.pageShell.clientHeight;
    return {
      left: Math.max(8, (rect.x * shellWidth) - 34),
      top: Math.min(
        Math.max(8, (rect.y * shellHeight) + ((rect.height * shellHeight) / 2) - 13),
        Math.max(8, shellHeight - 34),
      ),
    };
  }

  getCommentPopoverPosition(rect, pageState) {
    const shellWidth = pageState.pageShell.clientWidth;
    const shellHeight = pageState.pageShell.clientHeight;
    const popoverWidth = 252;
    const popoverHeight = 168;
    const defaultLeft = Math.min(
      Math.max(14, rect.x * shellWidth),
      Math.max(14, shellWidth - popoverWidth - 14),
    );
    const belowTop = (rect.y + rect.height) * shellHeight + 14;
    const fitsBelow = belowTop + popoverHeight <= shellHeight - 12;

    return {
      left: defaultLeft,
      top: fitsBelow ? belowTop : Math.max(12, (rect.y * shellHeight) - popoverHeight - 12),
      placement: fitsBelow ? "bottom" : "top",
    };
  }

  clamp01(value) {
    return Math.min(1, Math.max(0, value));
  }

  async copyText(text) {
    if (!text) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.left = "-9999px";
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      textArea.remove();
    }
  }

  escapeHtml(text) {
    return String(text || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  debounce(fn, wait) {
    let timeoutId = null;
    return (...args) => {
      clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => fn(...args), wait);
    };
  }
}
