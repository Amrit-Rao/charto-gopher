import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.3.136/pdf.min.mjs";
import { GraphController } from "./graph-openalex.js";
import { loadPdfDescriptor, buildDocumentKey } from "./pdf-utils.js";
import { ReaderController } from "./reader.js";
import {
  addDocument,
  emit,
  findDocumentByKey,
  getCurrentDocument,
  removeDocument,
  selectDocument,
  setGraphConfig,
  setGraphStatus,
  setMode,
  setResolverTemplate,
  state,
  subscribe,
} from "./store.js";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.3.136/pdf.worker.min.mjs";

const elements = {
  upload: document.getElementById("pdf-upload"),
  documentsList: document.getElementById("documents-list"),
  documentCount: document.getElementById("document-count"),
  modeReader: document.getElementById("mode-reader"),
  modeGraph: document.getElementById("mode-graph"),
  graphSummary: document.getElementById("graph-summary"),
  graphRibbonAction: document.getElementById("graph-ribbon-action"),
  readerPanel: document.getElementById("reader-panel"),
  readerEmptyState: document.getElementById("reader-empty-state"),
  pdfContainer: document.getElementById("pdf-container"),
  currentPage: document.getElementById("current-page"),
  totalPages: document.getElementById("total-pages"),
  prevPage: document.getElementById("prev-page"),
  nextPage: document.getElementById("next-page"),
  readerSidebar: document.getElementById("reader-sidebar"),
  graphSidebar: document.getElementById("graph-sidebar"),
  commentsList: document.getElementById("comments-list"),
  commentCount: document.getElementById("comment-count"),
  notesTextarea: document.getElementById("notes-textarea"),
  notesPreview: document.getElementById("notes-preview"),
  notesStatus: document.getElementById("notes-status"),
  tabComments: document.getElementById("tab-comments"),
  tabNotes: document.getElementById("tab-notes"),
  commentsView: document.getElementById("comments-view"),
  notesView: document.getElementById("notes-view"),
  selectionToolbar: document.getElementById("selection-toolbar"),
  highlightOnly: document.getElementById("highlight-only"),
  highlightComment: document.getElementById("highlight-comment"),
  modal: document.getElementById("comment-modal"),
  modalContext: document.getElementById("modal-context"),
  commentInput: document.getElementById("comment-input"),
  saveComment: document.getElementById("save-comment"),
  cancelComment: document.getElementById("cancel-comment"),
  closeModal: document.getElementById("close-modal"),
  graphPanel: document.getElementById("graph-panel"),
  graphEmptyState: document.getElementById("graph-empty-state"),
  graphStage: document.getElementById("graph-stage"),
  graphEdges: document.getElementById("graph-edges"),
  graphEdgesGroup: document.getElementById("graph-edges-group"),
  graphNodes: document.getElementById("graph-nodes"),
  graphStatus: document.getElementById("graph-status"),
  graphSelection: document.getElementById("graph-selection"),
  resolverTemplate: document.getElementById("resolver-template"),
  fetchReferenceMetadata: document.getElementById("fetch-reference-metadata"),
  resolverStatus: document.getElementById("resolver-status"),
  changeGraphConfig: document.getElementById("change-graph-config"),
  graphConfigModal: document.getElementById("graph-config-modal"),
  closeGraphConfig: document.getElementById("close-graph-config"),
  cancelGraphConfig: document.getElementById("cancel-graph-config"),
  buildGraph: document.getElementById("build-graph"),
  seedList: document.getElementById("seed-list"),
  graphDepth: document.getElementById("graph-depth"),
};

const reader = new ReaderController(elements, pdfjsLib);
const graph = new GraphController(elements);

attachEvents();
subscribe(renderStaticShell);
renderStaticShell();
renderActiveMode();

function attachEvents() {
  elements.upload.addEventListener("change", onFileUpload);
  elements.modeReader.addEventListener("click", () => switchMode("reader"));
  elements.modeGraph.addEventListener("click", () => openGraphConfig());
  elements.graphRibbonAction.addEventListener("click", () => openGraphConfig());
  elements.changeGraphConfig.addEventListener("click", () => openGraphConfig());
  elements.closeGraphConfig.addEventListener("click", closeGraphConfigModal);
  elements.cancelGraphConfig.addEventListener("click", closeGraphConfigModal);
  elements.buildGraph.addEventListener("click", applyGraphConfig);
  elements.resolverTemplate.addEventListener("change", () => setResolverTemplate(elements.resolverTemplate.value.trim()));
}

async function onFileUpload(event) {
  const files = Array.from(event.target.files ?? []);
  if (files.length === 0) return;
  for (const file of files) {
    const key = buildDocumentKey(file);
    const existing = findDocumentByKey(key);
    if (existing) {
      selectDocument(existing.id);
      continue;
    }
    const descriptor = await loadPdfDescriptor(file, pdfjsLib);
    addDocument({
      id: crypto.randomUUID(),
      key,
      file,
      pdfDoc: descriptor.pdfDoc,
      metadata: descriptor.metadata,
      name: file.name,
      title: descriptor.title,
      abstract: descriptor.abstract,
      firstPagePreview: descriptor.firstPagePreview,
      identifiers: descriptor.identifiers,
      openAlex: descriptor.openAlex,
      validationError: descriptor.openAlex.valid ? "" : descriptor.openAlex.error,
      size: file.size,
      comments: readStored(`comments:${key}`, []),
      notes: readStored(`notes:${key}`, ""),
      highlights: readStored(`highlights:${key}`, []),
      lastReaderPage: 1,
    });
  }
  event.target.value = "";
  renderActiveMode();
}

function switchMode(mode) {
  setMode(mode);
  renderActiveMode();
}

function renderStaticShell() {
  renderDocumentsList();
  updateModeButtons();
  updateGraphSummaryText();
  elements.graphStatus.textContent = state.graphStatus;
  elements.resolverStatus.textContent = state.resolverStatus;
  elements.resolverTemplate.value = state.resolverTemplate;
}

function renderActiveMode() {
  if (state.mode === "reader") {
    graph.deactivate();
    reader.activate();
  } else {
    reader.deactivate();
    graph.activate();
  }
}

function renderDocumentsList() {
  elements.documentCount.textContent = String(state.documents.length);
  if (state.documents.length === 0) {
    elements.documentsList.innerHTML = '<div class="placeholder-card">No PDFs loaded yet.</div>';
    return;
  }
  const fragment = document.createDocumentFragment();
  state.documents.forEach((doc) => {
    const row = document.createElement("div");
    row.className = "document-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = `document-item${doc.id === state.selectedDocumentId ? " is-active" : ""}${doc.validationError ? " is-invalid" : ""}`;
    button.innerHTML = `
      <strong>${escapeHtml(doc.title)}</strong>
      <span>${formatBytes(doc.size)} · ${doc.pdfDoc.numPages} pages</span>
      <span>${doc.comments.length} comment${doc.comments.length === 1 ? "" : "s"} · ${(doc.highlights || []).length} highlight${(doc.highlights || []).length === 1 ? "" : "s"}</span>
      ${doc.validationError ? `<span class="document-error">${escapeHtml(doc.validationError)}</span>` : `<span>${doc.openAlex?.confidence ? `OpenAlex match ${(doc.openAlex.confidence * 100).toFixed(0)}%` : "Validated"}</span>`}
    `;
    button.addEventListener("click", () => {
      selectDocument(doc.id);
      renderActiveMode();
    });
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "document-remove";
    removeButton.textContent = "×";
    removeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      removeDocument(doc.id);
      localStorage.removeItem(`comments:${doc.key}`);
      localStorage.removeItem(`notes:${doc.key}`);
      localStorage.removeItem(`highlights:${doc.key}`);
      renderActiveMode();
    });
    row.appendChild(button);
    row.appendChild(removeButton);
    fragment.appendChild(row);
  });
  elements.documentsList.innerHTML = "";
  elements.documentsList.appendChild(fragment);
}

function updateModeButtons() {
  const readerActive = state.mode === "reader";
  elements.modeReader.classList.toggle("is-active", readerActive);
  elements.modeGraph.classList.toggle("is-active", !readerActive);
}

function updateGraphSummaryText() {
  const current = getCurrentDocument();
  if (!current) {
    elements.graphSummary.textContent = "Open a PDF, then pop the graph open to map references.";
    return;
  }
  const seedCount = state.graphConfig.seedDocIds.length;
  elements.graphSummary.textContent = `${current.title} · ${seedCount} seed paper${seedCount === 1 ? "" : "s"} selected for graph depth ${state.graphConfig.depth}.`;
}

function openGraphConfig() {
  if (!state.documents.length) return;
  const fragment = document.createDocumentFragment();
  state.documents.forEach((doc) => {
    const option = document.createElement("label");
    option.className = `seed-option${doc.validationError ? " is-invalid" : ""}`;
    option.innerHTML = `
      <input type="checkbox" value="${doc.id}" ${state.graphConfig.seedDocIds.includes(doc.id) ? "checked" : ""} ${doc.validationError ? "disabled" : ""}>
      <span><strong>${escapeHtml(doc.title)}</strong><span>${doc.validationError ? escapeHtml(doc.validationError) : "Validated for graph seeding"}</span></span>
    `;
    fragment.appendChild(option);
  });
  elements.seedList.innerHTML = "";
  elements.seedList.appendChild(fragment);
  elements.graphDepth.value = String(state.graphConfig.depth || 1);
  elements.graphConfigModal.classList.remove("hidden");
}

function closeGraphConfigModal() {
  elements.graphConfigModal.classList.add("hidden");
}

function applyGraphConfig() {
  const selected = Array.from(elements.seedList.querySelectorAll("input:checked")).slice(0, 3).map((input) => input.value);
  const depth = Number(elements.graphDepth.value) || 1;
  setGraphConfig({ seedDocIds: selected, depth });
  closeGraphConfigModal();
  setMode("graph");
  renderActiveMode();
}

function readStored(key, fallback) {
  const value = localStorage.getItem(key);
  if (!value) return fallback;
  if (typeof fallback === "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function escapeHtml(text) {
  return String(text || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
