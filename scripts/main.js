import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.3.136/pdf.min.mjs";
import { GraphController } from "./graph-openalex.js";
import { buildDocumentKey, enrichPdfDescriptor, loadPdfDescriptor } from "./pdf-utils.js";
import { ReaderController } from "./reader.js";
import { AISummaryController } from "./ai-summary-controller.js";
import {
  addDocument,
  findDocumentByKey,
  getCurrentDocument,
  removeDocument,
  selectDocument,
  setGraphConfig,
  setMode,
  setResolverTemplate,
  state,
  subscribe,
  updateDocument,
} from "./store.js";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.3.136/pdf.worker.min.mjs";

const elements = {
  upload: document.getElementById("pdf-upload"),
  uploadStatus: document.getElementById("upload-status"),
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
  tabAi: document.getElementById("tab-ai"),
  commentsView: document.getElementById("comments-view"),
  notesView: document.getElementById("notes-view"),
  selectionContextMenu: document.getElementById("selection-context-menu"),
  selectionCopy: document.getElementById("selection-copy"),
  selectionHighlight: document.getElementById("selection-highlight"),
  selectionHighlightComment: document.getElementById("selection-highlight-comment"),
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
  graphMaxRefs: document.getElementById("graph-max-refs"),
  graphMaxRefsDisplay: document.getElementById("graph-max-refs-display"),
  resetGraphLayout: document.getElementById("reset-graph-layout"),
  graphNodeColors: document.getElementById("graph-node-colors"),
  graphNodeNotes: document.getElementById("graph-node-notes"),
  graphNodeMetaControls: document.getElementById("graph-node-meta-controls"),
  graphIndicators: document.getElementById("graph-indicators"),
  graphContextMenu: document.getElementById("graph-context-menu"),
  contextNodeColors: document.getElementById("context-node-colors"),
  contextDownloadBtn: document.getElementById("context-download-btn"),
  graphZoomIn: document.getElementById("graph-zoom-in"),
  graphZoomReset: document.getElementById("graph-zoom-reset"),
  graphZoomOut: document.getElementById("graph-zoom-out"),
};

const reader = new ReaderController(elements, pdfjsLib);
const graph = new GraphController(elements);
let latestUploadBatchId = 0;

attachEvents();
subscribe(renderStaticShell);
renderStaticShell();
renderActiveMode();

function attachEvents() {
  elements.upload.addEventListener("change", onFileUpload);
  elements.modeReader.addEventListener("click", () => switchMode("reader"));
  elements.modeGraph.addEventListener("click", openGraphConfig);
  elements.graphRibbonAction.addEventListener("click", openGraphConfig);
  elements.changeGraphConfig.addEventListener("click", openGraphConfig);
  elements.closeGraphConfig.addEventListener("click", closeGraphConfigModal);
  elements.cancelGraphConfig.addEventListener("click", closeGraphConfigModal);
  elements.buildGraph.addEventListener("click", applyGraphConfig);
  elements.resolverTemplate.addEventListener("change", () => {
    setResolverTemplate(elements.resolverTemplate.value.trim());
  });
}

async function onFileUpload(event) {
  const files = Array.from(event.target.files ?? []);
  if (files.length === 0) {
    return;
  }

  const batchId = ++latestUploadBatchId;
  const summary = {
    added: 0,
    duplicates: 0,
    failed: [],
  };
  setUploadStatus(`Loading ${files.length} PDF${files.length === 1 ? "" : "s"}...`);

  for (const file of files) {
    if (!isPdfFile(file)) {
      summary.failed.push({
        name: file.name,
        error: "Only PDF files can be uploaded here.",
      });
      continue;
    }

    try {
      const key = buildDocumentKey(file);
      const existing = findDocumentByKey(key);
      if (existing) {
        selectDocument(existing.id);
        renderActiveMode();
        summary.duplicates += 1;
        continue;
      }

      const descriptor = await loadPdfDescriptor(file, pdfjsLib);
      const documentRecord = {
        id: crypto.randomUUID(),
        key,
        file,
        pdfDoc: descriptor.pdfDoc,
        metadata: descriptor.metadata,
        name: file.name,
        title: descriptor.title,
        abstract: descriptor.abstract,
        firstPagePreview: "",
        identifiers: descriptor.identifiers,
        openAlex: { valid: false, confidence: 0, pending: true },
        validationError: "",
        size: file.size,
        comments: readStored(`comments:${key}`, []),
        notes: readStored(`notes:${key}`, ""),
        highlights: readStored(`highlights:${key}`, []),
        lastReaderPage: 1,
      };

      addDocument(documentRecord);
      renderActiveMode();
      summary.added += 1;
      void hydrateDocument(documentRecord.id, descriptor);
    } catch (error) {
      console.error("Upload failed for", file.name, error);
      summary.failed.push({
        name: file.name,
        error: describeError(error),
      });
    }
  }

  event.target.value = "";
  renderActiveMode();
  if (batchId === latestUploadBatchId) {
    setUploadStatus(buildUploadStatus(summary), summary.failed.length > 0);
  }
}

async function hydrateDocument(documentId, descriptor) {
  try {
    const enrichment = await enrichPdfDescriptor(descriptor);
    updateDocument(documentId, (doc) => {
      doc.firstPagePreview = enrichment.firstPagePreview;
      doc.openAlex = enrichment.openAlex;
      doc.validationError = enrichment.openAlex.valid ? "" : enrichment.openAlex.error;
    });
  } catch (error) {
    console.error("Document enrichment failed", error);
    updateDocument(documentId, (doc) => {
      doc.openAlex = {
        valid: false,
        confidence: 0,
        pending: false,
        error: "Preview or OpenAlex enrichment failed.",
      };
      doc.validationError = "Preview or OpenAlex enrichment failed.";
    });
  }
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
    return;
  }

  reader.deactivate();
  graph.activate();
}

function renderDocumentsList() {
  elements.documentCount.textContent = String(state.documents.length);
  if (state.documents.length === 0) {
    elements.documentsList.innerHTML = '<div class="placeholder-card">No PDFs loaded yet.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const doc of state.documents) {
    const row = document.createElement("div");
    row.className = "document-row";

    const button = document.createElement("button");
    button.type = "button";
    button.className = `document-item${doc.id === state.selectedDocumentId ? " is-active" : ""}${doc.validationError ? " is-invalid" : ""}`;
    const validationSummary = doc.openAlex?.pending
      ? "Validating against OpenAlex..."
      : doc.validationError
        ? `<span class="document-error">${escapeHtml(doc.validationError)}</span>`
        : `<span>${doc.openAlex?.confidence ? `OpenAlex match ${(doc.openAlex.confidence * 100).toFixed(0)}%` : "Validated"}</span>`;
    button.innerHTML = `
      <strong>${escapeHtml(doc.title)}</strong>
      <span>${formatBytes(doc.size)} - ${doc.pdfDoc.numPages} pages</span>
      <span>${doc.comments.length} comment${doc.comments.length === 1 ? "" : "s"} - ${(doc.highlights || []).length} highlight${(doc.highlights || []).length === 1 ? "" : "s"}</span>
      ${validationSummary}
    `;
    button.addEventListener("click", () => {
      selectDocument(doc.id);
      renderActiveMode();
    });

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "document-remove";
    removeButton.textContent = "x";
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
  }

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
  elements.graphSummary.textContent = `${current.title} - ${seedCount} seed paper${seedCount === 1 ? "" : "s"} selected for graph depth ${state.graphConfig.depth}.`;
}

function openGraphConfig() {
  if (!state.documents.length) {
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const doc of state.documents) {
    const option = document.createElement("label");
    const disabled = Boolean(doc.validationError || doc.openAlex?.pending);
    option.className = `seed-option${disabled ? " is-invalid" : ""}`;
    option.innerHTML = `
      <input type="checkbox" value="${doc.id}" ${state.graphConfig.seedDocIds.includes(doc.id) ? "checked" : ""} ${disabled ? "disabled" : ""}>
      <span><strong>${escapeHtml(doc.title)}</strong><span>${doc.openAlex?.pending ? "Validation in progress..." : doc.validationError ? escapeHtml(doc.validationError) : "Validated for graph seeding"}</span></span>
    `;
    fragment.appendChild(option);
  }

  elements.seedList.innerHTML = "";
  elements.seedList.appendChild(fragment);
  elements.graphDepth.value = String(state.graphConfig.depth || 1);
  elements.graphConfigModal.classList.remove("hidden");
}

function closeGraphConfigModal() {
  elements.graphConfigModal.classList.add("hidden");
}

function applyGraphConfig() {
  const selected = Array.from(elements.seedList.querySelectorAll("input:checked"))
    .slice(0, 3)
    .map((input) => input.value);
  const depth = Number(elements.graphDepth.value) || 1;
  const maxRefs = elements.graphMaxRefs ? (Number(elements.graphMaxRefs.value) || 5) : 5;
  setGraphConfig({ seedDocIds: selected, depth, maxRefs });
  closeGraphConfigModal();
  setMode("graph");
  renderActiveMode();
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

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isPdfFile(file) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

function setUploadStatus(message, isError = false) {
  elements.uploadStatus.textContent = message;
  elements.uploadStatus.classList.toggle("is-error", isError);
}

function buildUploadStatus(summary) {
  const parts = [];
  if (summary.added > 0) {
    parts.push(`Loaded ${summary.added} PDF${summary.added === 1 ? "" : "s"}.`);
  }
  if (summary.duplicates > 0) {
    parts.push(`Skipped ${summary.duplicates} duplicate${summary.duplicates === 1 ? "" : "s"}.`);
  }
  if (summary.failed.length > 0) {
    parts.push(`Failed ${summary.failed.length}: ${summary.failed.map((entry) => entry.name).join(", ")}.`);
  }
  return parts.join(" ") || "No files were uploaded.";
}

function describeError(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "This file could not be opened as a PDF.";
}

function isPdfFile(file) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

function setUploadStatus(message, isError = false) {
  elements.uploadStatus.textContent = message;
  elements.uploadStatus.classList.toggle("is-error", isError);
}

function buildUploadStatus(summary) {
  const parts = [];
  if (summary.added > 0) {
    parts.push(`Loaded ${summary.added} PDF${summary.added === 1 ? "" : "s"}.`);
  }
  if (summary.duplicates > 0) {
    parts.push(`Skipped ${summary.duplicates} duplicate${summary.duplicates === 1 ? "" : "s"}.`);
  }
  if (summary.failed.length > 0) {
    parts.push(`Failed ${summary.failed.length}: ${summary.failed.map((entry) => entry.name).join(", ")}.`);
  }
  return parts.join(" ") || "No files were uploaded.";
}

function describeError(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "This file could not be opened as a PDF.";
}


