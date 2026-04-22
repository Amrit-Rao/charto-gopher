const listeners = new Set();

export const state = {
  mode: "reader",
  documents: [],
  selectedDocumentId: null,
  graphStatus: "Graph is idle.",
  resolverStatus: "No fetches run yet.",
  graphSelectionId: null,
  graphConfig: {
    seedDocIds: [],
    depth: 1,
    maxRefs: 5,
  },
  resolverTemplate: "https://api.openalex.org/works?search={query}&per-page=5",
  graphNodeMeta: {},
  sessionId: crypto.randomUUID(),
};

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emit() {
  for (const listener of listeners) {
    listener(state);
  }
}

export function addDocument(documentRecord) {
  state.documents.push(documentRecord);
  state.selectedDocumentId = documentRecord.id;
  emit();
}

export function removeDocument(documentId) {
  const index = state.documents.findIndex((doc) => doc.id === documentId);
  if (index === -1) {
    return;
  }

  state.documents.splice(index, 1);
  if (state.selectedDocumentId === documentId) {
    state.selectedDocumentId = state.documents[0]?.id || null;
  }
  state.graphConfig.seedDocIds = state.graphConfig.seedDocIds.filter((id) => id !== documentId);
  emit();
}

export function selectDocument(documentId) {
  state.selectedDocumentId = documentId;
  emit();
}

export function getCurrentDocument() {
  return state.documents.find((doc) => doc.id === state.selectedDocumentId) ?? null;
}

export function findDocumentByKey(key) {
  return state.documents.find((doc) => doc.key === key) ?? null;
}

export function updateDocument(documentId, updater) {
  const doc = state.documents.find((item) => item.id === documentId);
  if (!doc) {
    return null;
  }
  updater(doc);
  emit();
  return doc;
}

export function setMode(mode) {
  state.mode = mode;
  emit();
}

export function setGraphStatus(message) {
  state.graphStatus = message;
  emit();
}

export function setResolverStatus(message) {
  state.resolverStatus = message;
  emit();
}

export function setGraphSelection(nodeId) {
  state.graphSelectionId = nodeId;
  emit();
}

export function setGraphConfig(config) {
  state.graphConfig = config;
  emit();
}

export function setResolverTemplate(template) {
  state.resolverTemplate = template;
  emit();
}

export function updateGraphNodeMeta(nodeId, data) {
  if (!state.graphNodeMeta[nodeId]) {
    state.graphNodeMeta[nodeId] = {};
  }
  Object.assign(state.graphNodeMeta[nodeId], data);
  emit();
}
