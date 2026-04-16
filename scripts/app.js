import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.3.136/pdf.min.mjs";
import { marked } from "https://cdn.jsdelivr.net/npm/marked/lib/marked.esm.js";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.3.136/pdf.worker.min.mjs";

marked.setOptions({
  gfm: true,
  breaks: true,
  headerIds: false,
  mangle: false,
});

const state = {
  documents: [],
  selectedDocumentId: null,
  pageStates: new Map(),
  currentPage: 0,
  pendingComment: null,
  activeCommentId: null,
  notesSaveTimer: null,
  observer: null,
};

const elements = {
  upload: document.getElementById("pdf-upload"),
  readerPanel: document.getElementById("reader-panel"),
  pdfContainer: document.getElementById("pdf-container"),
  emptyState: document.getElementById("empty-state"),
  documentsList: document.getElementById("documents-list"),
  documentCount: document.getElementById("document-count"),
  currentPage: document.getElementById("current-page"),
  totalPages: document.getElementById("total-pages"),
  prevPage: document.getElementById("prev-page"),
  nextPage: document.getElementById("next-page"),
  commentsList: document.getElementById("comments-list"),
  commentCount: document.getElementById("comment-count"),
  notesTextarea: document.getElementById("notes-textarea"),
  notesPreview: document.getElementById("notes-preview"),
  notesStatus: document.getElementById("notes-status"),
  tabComments: document.getElementById("tab-comments"),
  tabNotes: document.getElementById("tab-notes"),
  commentsView: document.getElementById("comments-view"),
  notesView: document.getElementById("notes-view"),
  modal: document.getElementById("comment-modal"),
  modalContext: document.getElementById("modal-context"),
  commentInput: document.getElementById("comment-input"),
  saveComment: document.getElementById("save-comment"),
  cancelComment: document.getElementById("cancel-comment"),
  closeModal: document.getElementById("close-modal"),
};

elements.upload.addEventListener("change", onFileUpload);
elements.prevPage.addEventListener("click", () => scrollToPage(state.currentPage - 1));
elements.nextPage.addEventListener("click", () => scrollToPage(state.currentPage + 1));
elements.tabComments.addEventListener("click", () => setActiveTab("comments"));
elements.tabNotes.addEventListener("click", () => setActiveTab("notes"));
elements.notesTextarea.addEventListener("input", onNotesInput);
elements.saveComment.addEventListener("click", commitComment);
elements.cancelComment.addEventListener("click", closeCommentModal);
elements.closeModal.addEventListener("click", closeCommentModal);
elements.modal.addEventListener("click", (event) => {
  if (event.target === elements.modal) {
    closeCommentModal();
  }
});

window.addEventListener("resize", debounce(handleResize, 150));

async function onFileUpload(event) {
  const files = Array.from(event.target.files ?? []);
  if (files.length === 0) {
    return;
  }

  for (const file of files) {
    const documentKey = buildDocumentKey(file);
    const existing = state.documents.find((doc) => doc.key === documentKey);
    if (existing) {
      state.selectedDocumentId = existing.id;
      continue;
    }

    const bytes = await file.arrayBuffer();
    const pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
    const comments = readStored(`comments:${documentKey}`, []);
    const notes = readStored(`notes:${documentKey}`, "");

    state.documents.push({
      id: crypto.randomUUID(),
      key: documentKey,
      file,
      pdfDoc,
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      comments,
      notes,
      nextCommentNumber: getNextCommentNumber(comments),
    });

    state.selectedDocumentId = state.documents[state.documents.length - 1].id;
  }

  elements.upload.value = "";
  renderDocumentList();
  await showSelectedDocument();
}

function buildDocumentKey(file) {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

function getCurrentDocument() {
  return state.documents.find((doc) => doc.id === state.selectedDocumentId) ?? null;
}

function renderDocumentList() {
  elements.documentCount.textContent = String(state.documents.length);

  if (state.documents.length === 0) {
    elements.documentsList.innerHTML = '<div class="placeholder-card">No PDFs loaded yet.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const doc of state.documents) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "document-item";
    if (doc.id === state.selectedDocumentId) {
      button.classList.add("is-active");
    }

    button.innerHTML = `
      <strong>${escapeHtml(doc.name)}</strong>
      <span>${formatBytes(doc.size)} � ${doc.pdfDoc.numPages} pages</span>
      <span>${doc.comments.length} comment${doc.comments.length === 1 ? "" : "s"} � ${doc.notes.trim() ? "notes saved" : "no notes yet"}</span>
    `;

    button.addEventListener("click", async () => {
      if (doc.id === state.selectedDocumentId) {
        return;
      }

      state.selectedDocumentId = doc.id;
      state.activeCommentId = null;
      renderDocumentList();
      await showSelectedDocument();
    });

    fragment.appendChild(button);
  }

  elements.documentsList.innerHTML = "";
  elements.documentsList.appendChild(fragment);
}

async function showSelectedDocument() {
  teardownRenderedDocument();

  const doc = getCurrentDocument();
  if (!doc) {
    renderEmptyShell();
    return;
  }

  elements.emptyState.classList.add("hidden");
  elements.pdfContainer.classList.remove("hidden");
  elements.totalPages.textContent = String(doc.pdfDoc.numPages);
  elements.currentPage.textContent = "1";

  await buildPages(doc);
  renderCommentsList();
  renderAllCommentPills();
  updateNotesUI();
}

function teardownRenderedDocument() {
  state.pageStates.clear();
  state.currentPage = 0;
  state.pendingComment = null;
  clearTimeout(state.notesSaveTimer);

  if (state.observer) {
    state.observer.disconnect();
    state.observer = null;
  }

  elements.pdfContainer.innerHTML = "";
  elements.currentPage.textContent = "0";
  elements.totalPages.textContent = "0";
  elements.commentCount.textContent = "0 comments";
  elements.commentsList.innerHTML = '<div class="placeholder-card">No comments yet.</div>';
  elements.notesTextarea.value = "";
  elements.notesPreview.innerHTML = '<div class="placeholder-card">Your rendered notes will appear here.</div>';
  elements.notesStatus.textContent = "Nothing saved yet.";
}

function renderEmptyShell() {
  elements.emptyState.classList.remove("hidden");
  elements.pdfContainer.classList.add("hidden");
}

async function buildPages(doc) {
  const fragment = document.createDocumentFragment();

  state.observer = new IntersectionObserver(handlePageVisibility, {
    root: elements.readerPanel,
    threshold: 0.3,
  });

  for (let pageNumber = 1; pageNumber <= doc.pdfDoc.numPages; pageNumber += 1) {
    const pageElement = document.createElement("article");
    pageElement.className = "pdf-page";
    pageElement.dataset.pageNumber = String(pageNumber);

    const label = document.createElement("div");
    label.className = "page-label";
    label.textContent = `Page ${pageNumber}`;

    const shell = document.createElement("div");
    shell.className = "page-shell";

    const canvas = document.createElement("canvas");
    canvas.className = "page-canvas";

    const overlay = document.createElement("div");
    overlay.className = "page-overlay";
    overlay.addEventListener("click", (event) => openCommentModal(event, pageNumber));

    shell.appendChild(canvas);
    shell.appendChild(overlay);
    pageElement.appendChild(label);
    pageElement.appendChild(shell);
    fragment.appendChild(pageElement);

    state.pageStates.set(pageNumber, {
      pageNumber,
      pageElement,
      canvas,
      overlay,
      rendered: false,
      renderTask: null,
    });
  }

  elements.pdfContainer.appendChild(fragment);
  elements.readerPanel.scrollTop = 0;

  for (const pageState of state.pageStates.values()) {
    state.observer.observe(pageState.pageElement);
  }
}

async function handlePageVisibility(entries) {
  const doc = getCurrentDocument();
  if (!doc) {
    return;
  }

  for (const entry of entries) {
    const pageNumber = Number(entry.target.dataset.pageNumber);
    if (entry.isIntersecting) {
      state.currentPage = pageNumber;
      elements.currentPage.textContent = String(pageNumber);
    }

    const pageState = state.pageStates.get(pageNumber);
    if (!entry.isIntersecting || !pageState || pageState.rendered || pageState.renderTask) {
      continue;
    }

    pageState.renderTask = renderPage(doc, pageState);
    await pageState.renderTask;
    pageState.renderTask = null;
  }
}

async function renderPage(doc, pageState) {
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

  await pdfPage.render({
    canvasContext: context,
    viewport,
  }).promise;

  pageState.overlay.style.width = `${viewport.width}px`;
  pageState.overlay.style.height = `${viewport.height}px`;
  pageState.rendered = true;

  renderCommentPillsForPage(pageState.pageNumber);
}

function openCommentModal(event, pageNumber) {
  const doc = getCurrentDocument();
  if (!doc) {
    return;
  }

  const overlay = event.currentTarget;
  const bounds = overlay.getBoundingClientRect();
  const x = (event.clientX - bounds.left) / bounds.width;
  const y = (event.clientY - bounds.top) / bounds.height;

  state.pendingComment = { pageNumber, x, y };
  elements.modalContext.textContent = `Page ${pageNumber}|${doc.name}`;
  elements.commentInput.value = "";
  elements.modal.classList.remove("hidden");
  elements.modal.setAttribute("aria-hidden", "false");
  elements.commentInput.focus();
}

function closeCommentModal() {
  state.pendingComment = null;
  elements.modal.classList.add("hidden");
  elements.modal.setAttribute("aria-hidden", "true");
}

function commitComment() {
  const doc = getCurrentDocument();
  const text = elements.commentInput.value.trim();
  if (!doc || !text || !state.pendingComment) {
    closeCommentModal();
    return;
  }

  const comment = {
    id: crypto.randomUUID(),
    number: doc.nextCommentNumber,
    ref: `C${doc.nextCommentNumber}`,
    text,
    pageNumber: state.pendingComment.pageNumber,
    x: state.pendingComment.x,
    y: state.pendingComment.y,
    createdAt: new Date().toISOString(),
  };

  doc.nextCommentNumber += 1;
  doc.comments = [comment, ...doc.comments];
  state.activeCommentId = comment.id;
  persistDocument(doc);
  renderDocumentList();
  renderCommentsList();
  renderCommentPillsForPage(comment.pageNumber);
  renderNotesPreview();
  closeCommentModal();
}

function renderCommentsList() {
  const doc = getCurrentDocument();
  if (!doc) {
    elements.commentCount.textContent = "0 comments";
    elements.commentsList.innerHTML = '<div class="placeholder-card">No comments yet.</div>';
    return;
  }

  elements.commentCount.textContent = `${doc.comments.length} comment${doc.comments.length === 1 ? "" : "s"}`;

  if (doc.comments.length === 0) {
    elements.commentsList.innerHTML = '<div class="placeholder-card">No comments yet.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const comment of doc.comments) {
    const card = document.createElement("article");
    card.className = "comment-card";
    if (comment.id === state.activeCommentId) {
      card.classList.add("is-active");
    }

    card.dataset.commentId = comment.id;
    card.innerHTML = `
      <h3><span class="comment-tag">${comment.ref}</span><span>Page ${comment.pageNumber}</span></h3>
      <p>${escapeHtml(comment.text)}</p>
      <small>${formatDate(comment.createdAt)}</small>
    `;
    card.addEventListener("click", () => focusComment(comment.id));
    fragment.appendChild(card);
  }

  elements.commentsList.innerHTML = "";
  elements.commentsList.appendChild(fragment);
}

function renderAllCommentPills() {
  for (const pageState of state.pageStates.values()) {
    renderCommentPillsForPage(pageState.pageNumber);
  }
}

function renderCommentPillsForPage(pageNumber) {
  const doc = getCurrentDocument();
  const pageState = state.pageStates.get(pageNumber);
  if (!doc || !pageState) {
    return;
  }

  pageState.overlay.querySelectorAll(".comment-pill").forEach((node) => node.remove());

  const commentsForPage = doc.comments.filter((comment) => comment.pageNumber === pageNumber);
  for (const comment of commentsForPage) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "comment-pill";
    if (comment.id === state.activeCommentId) {
      button.classList.add("is-active");
    }

    button.dataset.commentId = comment.id;
    button.style.left = `${comment.x * 100}%`;
    button.style.top = `${comment.y * 100}%`;
    button.innerHTML = `
      <span class="comment-pill-id">${comment.ref}</span>
      <span class="comment-pill-text">${escapeHtml(truncate(comment.text, 38))}</span>
      <span class="comment-popover">
        <strong>${comment.ref} � Page ${comment.pageNumber}</strong>
        <span>${escapeHtml(comment.text)}</span>
        <small>${formatDate(comment.createdAt)}</small>
      </span>
    `;

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      focusComment(comment.id);
    });

    pageState.overlay.appendChild(button);
  }
}

function focusComment(commentId) {
  const doc = getCurrentDocument();
  if (!doc) {
    return;
  }

  const comment = doc.comments.find((item) => item.id === commentId);
  if (!comment) {
    return;
  }

  state.activeCommentId = comment.id;
  renderCommentsList();
  renderAllCommentPills();
  setActiveTab("comments");
  scrollToPage(comment.pageNumber);
}

function scrollToPage(pageNumber) {
  const pageState = state.pageStates.get(pageNumber);
  if (!pageState) {
    return;
  }

  const top = pageState.pageElement.offsetTop - 12;
  elements.readerPanel.scrollTo({
    top,
    behavior: "smooth",
  });
}

function setActiveTab(tab) {
  const commentsActive = tab === "comments";
  elements.tabComments.classList.toggle("is-active", commentsActive);
  elements.tabNotes.classList.toggle("is-active", !commentsActive);
  elements.tabComments.setAttribute("aria-selected", String(commentsActive));
  elements.tabNotes.setAttribute("aria-selected", String(!commentsActive));
  elements.commentsView.classList.toggle("hidden", !commentsActive);
  elements.notesView.classList.toggle("hidden", commentsActive);
}

function onNotesInput(event) {
  const doc = getCurrentDocument();
  if (!doc) {
    return;
  }

  doc.notes = event.target.value;
  elements.notesStatus.textContent = "Saving...";
  renderNotesPreview();

  clearTimeout(state.notesSaveTimer);
  state.notesSaveTimer = window.setTimeout(() => {
    persistDocument(doc);
    renderDocumentList();
    elements.notesStatus.textContent = `Saved ${formatDate(new Date().toISOString())}`;
  }, 250);
}

function updateNotesUI() {
  const doc = getCurrentDocument();
  if (!doc) {
    elements.notesTextarea.value = "";
    elements.notesPreview.innerHTML = '<div class="placeholder-card">Your rendered notes will appear here.</div>';
    elements.notesStatus.textContent = "Nothing saved yet.";
    return;
  }

  elements.notesTextarea.value = doc.notes;
  renderNotesPreview();
  elements.notesStatus.textContent = doc.notes.trim() ? "Loaded saved notes." : "Nothing saved yet.";
}

function renderNotesPreview() {
  const doc = getCurrentDocument();
  if (!doc) {
    return;
  }

  if (!doc.notes.trim()) {
    elements.notesPreview.innerHTML = '<div class="placeholder-card">Your rendered notes will appear here.</div>';
    return;
  }

  const html = marked.parse(doc.notes);
  const withRefs = html.replace(/\[\[(C\d+)\]\]/g, (match, ref) => {
    const comment = doc.comments.find((item) => item.ref === ref);
    if (!comment) {
      return `<span class="comment-ref" title="No comment found">${ref}</span>`;
    }

    return `<button type="button" class="comment-ref" data-comment-id="${comment.id}" title="Jump to ${ref}">${ref}</button>`;
  });

  elements.notesPreview.innerHTML = withRefs;
  elements.notesPreview.querySelectorAll(".comment-ref[data-comment-id]").forEach((node) => {
    node.addEventListener("click", () => {
      const commentId = node.getAttribute("data-comment-id");
      if (!commentId) {
        return;
      }

      focusComment(commentId);
    });
  });
}

function persistDocument(doc) {
  localStorage.setItem(`comments:${doc.key}`, JSON.stringify(doc.comments));
  localStorage.setItem(`notes:${doc.key}`, doc.notes);
}

function readStored(key, fallback) {
  const value = localStorage.getItem(key);
  if (!value) {
    return fallback;
  }

  if (typeof fallback === "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getNextCommentNumber(comments) {
  const maxNumber = comments.reduce((highest, comment) => {
    return Math.max(highest, Number(comment.number) || 0);
  }, 0);

  return maxNumber + 1;
}

async function handleResize() {
  const doc = getCurrentDocument();
  if (!doc) {
    return;
  }

  for (const pageState of state.pageStates.values()) {
    pageState.rendered = false;
    await renderPage(doc, pageState);
  }
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDate(isoString) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(isoString));
}

function truncate(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1)}...`;
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function debounce(fn, wait) {
  let timeoutId = null;

  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => fn(...args), wait);
  };
}