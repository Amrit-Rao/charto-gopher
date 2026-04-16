import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import {
  DEFAULT_RESOLVER_TEMPLATE,
  setGraphSelection,
  setGraphStatus,
  setResolverStatus,
  state,
  updateDocument,
} from "./store.js";
import { extractDocumentGraphData, matchReferenceToUploaded, normalizeTitle } from "./pdf-utils.js";

export class GraphController {
  constructor(elements) {
    this.elements = elements;
    this.simulation = null;
    this.graphData = { nodes: [], links: [] };
    this.nodeMap = new Map();
    this.metadataCache = this.readStored("reference-metadata-cache", {});
    this.attachEvents();
  }

  attachEvents() {
    this.elements.graphRibbonAction.addEventListener("click", () => {
      document.getElementById("mode-graph").click();
    });

    this.elements.fetchReferenceMetadata.addEventListener("click", () => this.fetchMissingReferenceMetadata());
  }

  async activate() {
    this.elements.graphPanel.classList.remove("hidden");
    this.elements.graphSidebar.classList.remove("hidden");
    this.elements.resolverTemplate.value = state.graphResolverTemplate || DEFAULT_RESOLVER_TEMPLATE;

    if (state.documents.length === 0) {
      this.renderEmpty();
      return;
    }

    await this.ensureGraphData();
    this.renderGraph();
  }

  deactivate() {
    this.stopSimulation();
    this.elements.graphPanel.classList.add("hidden");
    this.elements.graphSidebar.classList.add("hidden");
  }

  renderEmpty() {
    this.elements.graphEmptyState.classList.remove("hidden");
    this.elements.graphStage.classList.add("hidden");
    this.elements.graphSelection.innerHTML = "Select a node to inspect it.";
  }

  async ensureGraphData() {
    const docsNeedingExtraction = state.documents.filter((doc) => doc.referencesStatus !== "ready" && doc.referencesStatus !== "loading");
    if (docsNeedingExtraction.length > 0) {
      setGraphStatus(`Extracting references from ${docsNeedingExtraction.length} document${docsNeedingExtraction.length === 1 ? "" : "s"}...`);
    }

    for (const doc of docsNeedingExtraction) {
      updateDocument(doc.id, (target) => {
        target.referencesStatus = "loading";
      });

      try {
        const graphData = await extractDocumentGraphData(doc);
        updateDocument(doc.id, (target) => {
          target.references = graphData.references;
          target.referencesStatus = "ready";
          target.referencesExtractedAt = new Date().toISOString();
        });
        localStorage.setItem(`references:${doc.key}`, JSON.stringify(graphData.references));
      } catch (error) {
        updateDocument(doc.id, (target) => {
          target.referencesStatus = "error";
          target.referencesError = String(error);
        });
      }
    }

    this.buildGraphData();
    const missingCount = this.graphData.nodes.filter((node) => !node.uploaded).length;
    setGraphStatus(`Graph ready: ${this.graphData.nodes.length} nodes, ${this.graphData.links.length} links, ${missingCount} missing references.`);
    this.updateGraphSummary();
  }

  buildGraphData() {
    const nodes = [];
    const links = [];
    const uploadedNodeIds = new Map();
    const referenceNodeIds = new Map();

    for (const doc of state.documents) {
      nodes.push({
        id: `doc:${doc.id}`,
        title: doc.title,
        uploaded: true,
        linked: false,
        previewImage: doc.firstPagePreview,
        previewText: doc.abstract || doc.title,
        metadata: `${doc.pdfDoc.numPages} pages · ${doc.references?.length || 0} refs`,
        sourceDocId: doc.id,
        raw: doc.abstract || doc.title,
        identifiers: doc.identifiers,
      });
      uploadedNodeIds.set(doc.id, `doc:${doc.id}`);
    }

    for (const doc of state.documents) {
      const sourceNodeId = uploadedNodeIds.get(doc.id);
      for (const reference of doc.references || []) {
        const matchedDoc = matchReferenceToUploaded(reference, state.documents.filter((candidate) => candidate.id !== doc.id));
        let targetNodeId = "";

        if (matchedDoc) {
          targetNodeId = uploadedNodeIds.get(matchedDoc.id);
          const uploadedNode = nodes.find((node) => node.id === targetNodeId);
          if (uploadedNode) {
            uploadedNode.linked = true;
          }
        } else {
          const referenceKey = reference.identifiers.doi
            || reference.identifiers.arxivId
            || normalizeTitle(reference.title)
            || reference.id;

          if (!referenceNodeIds.has(referenceKey)) {
            const cached = this.metadataCache[referenceKey] || {};
            const nodeId = `ref:${referenceKey}`;
            referenceNodeIds.set(referenceKey, nodeId);
            nodes.push({
              id: nodeId,
              cacheKey: referenceKey,
              title: cached.title || reference.title,
              uploaded: false,
              linked: false,
              previewImage: "",
              previewText: cached.abstract || reference.abstract || reference.previewText,
              metadata: this.buildReferenceMeta({ identifiers: reference.identifiers }),
              sourceDocId: doc.id,
              raw: reference.raw,
              identifiers: reference.identifiers,
              referenceRecord: reference,
            });
          }

          targetNodeId = referenceNodeIds.get(referenceKey);
        }

        if (sourceNodeId && targetNodeId && sourceNodeId !== targetNodeId) {
          links.push({ source: sourceNodeId, target: targetNodeId });
        }
      }
    }

    this.graphData = { nodes, links };
  }

  renderGraph() {
    this.stopSimulation();

    if (this.graphData.nodes.length === 0) {
      this.renderEmpty();
      return;
    }

    this.elements.graphEmptyState.classList.add("hidden");
    this.elements.graphStage.classList.remove("hidden");

    const nodeLayer = this.elements.graphNodes;
    const edgeSvg = this.elements.graphEdges;
    nodeLayer.innerHTML = "";
    edgeSvg.innerHTML = "";

    const rect = this.elements.graphStage.getBoundingClientRect();
    const width = rect.width || 900;
    const height = rect.height || 680;
    edgeSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    const edgeSelection = d3.select(edgeSvg)
      .selectAll("line")
      .data(this.graphData.links)
      .enter()
      .append("line")
      .attr("stroke", "rgba(125, 99, 66, 0.28)")
      .attr("stroke-width", 1.4);

    const nodeSelection = d3.select(nodeLayer)
      .selectAll("div")
      .data(this.graphData.nodes)
      .enter()
      .append("div")
      .attr("class", (node) => {
        const classes = ["graph-node"];
        if (node.uploaded) classes.push("is-uploaded");
        if (node.linked) classes.push("is-linked");
        if (node.id === state.graphSelectionId) classes.push("is-active");
        return classes.join(" ");
      })
      .html((node) => this.renderNodeCard(node))
      .on("mouseenter", (_, node) => this.renderSelection(node))
      .on("click", (_, node) => {
        setGraphSelection(node.id);
        this.highlightActiveNode();
        this.renderSelection(node);
      });

    this.simulation = d3.forceSimulation(this.graphData.nodes)
      .force("link", d3.forceLink(this.graphData.links).id((node) => node.id).distance((link) => {
        const target = typeof link.target === "string" ? this.graphData.nodes.find((node) => node.id === link.target) : link.target;
        return target?.uploaded ? 150 : 180;
      }))
      .force("charge", d3.forceManyBody().strength(-380))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide().radius((node) => node.uploaded ? 110 : 95))
      .on("tick", () => {
        edgeSelection
          .attr("x1", (link) => link.source.x)
          .attr("y1", (link) => link.source.y)
          .attr("x2", (link) => link.target.x)
          .attr("y2", (link) => link.target.y);

        nodeSelection
          .style("left", (node) => `${node.x}px`)
          .style("top", (node) => `${node.y}px`);
      });

    this.nodeMap = new Map(this.graphData.nodes.map((node) => [node.id, node]));
    const currentNode = this.nodeMap.get(state.graphSelectionId) || this.graphData.nodes[0];
    if (currentNode) {
      setGraphSelection(currentNode.id);
      this.highlightActiveNode();
      this.renderSelection(currentNode);
    }
  }

  highlightActiveNode() {
    this.elements.graphNodes.querySelectorAll(".graph-node").forEach((nodeElement, index) => {
      nodeElement.classList.toggle("is-active", this.graphData.nodes[index]?.id === state.graphSelectionId);
    });
  }

  renderNodeCard(node) {
    const missingBadge = node.uploaded ? "" : '<span class="node-missing">!</span>';
    const uploadedBadge = node.uploaded ? '<span class="node-chip">PDF</span>' : '<span class="node-chip">Ref</span>';
    const preview = node.previewImage
      ? `<div class="graph-node-preview"><img src="${node.previewImage}" alt="Preview for ${this.escapeHtml(node.title)}"></div>`
      : `<div class="graph-node-preview"><p>${this.escapeHtml(node.previewText || node.raw || "No preview available.")}</p></div>`;

    return `
      <div class="graph-node-top">
        <div>
          <h3 class="graph-node-title">${this.escapeHtml(this.truncate(node.title, 90))}</h3>
          <div class="graph-node-meta">${this.escapeHtml(node.metadata || "")}</div>
        </div>
        <div class="graph-node-badges">${uploadedBadge}${missingBadge}</div>
      </div>
      ${preview}
    `;
  }

  renderSelection(node) {
    if (!node) {
      this.elements.graphSelection.textContent = "Select a node to inspect it.";
      return;
    }

    const identifiers = [];
    if (node.identifiers?.doi) identifiers.push(`DOI: ${node.identifiers.doi}`);
    if (node.identifiers?.arxivId) identifiers.push(`arXiv: ${node.identifiers.arxivId}`);
    const preview = node.previewImage
      ? `<img src="${node.previewImage}" alt="Preview for ${this.escapeHtml(node.title)}">`
      : "";
    const link = node.identifiers?.arxivId
      ? `<p><a href="https://arxiv.org/abs/${node.identifiers.arxivId}" target="_blank" rel="noreferrer">Open arXiv abstract</a></p>`
      : "";

    this.elements.graphSelection.innerHTML = `
      <strong>${this.escapeHtml(node.title)}</strong>
      <p>${this.escapeHtml(node.uploaded ? "Uploaded document" : "Referenced paper")}</p>
      <p>${this.escapeHtml(node.previewText || node.raw || "No description available.")}</p>
      ${identifiers.length ? `<p>${this.escapeHtml(identifiers.join(" · "))}</p>` : ""}
      ${link}
      ${preview}
    `;
  }

  async fetchMissingReferenceMetadata() {
    const template = (this.elements.resolverTemplate.value || DEFAULT_RESOLVER_TEMPLATE).trim();
    this.elements.resolverTemplate.value = template;
    const missingNodes = this.graphData.nodes.filter((node) => !node.uploaded);
    if (missingNodes.length === 0) {
      setResolverStatus("There are no unresolved references to fetch.");
      return;
    }

    let successCount = 0;
    setResolverStatus(`Fetching metadata for ${missingNodes.length} reference${missingNodes.length === 1 ? "" : "s"}...`);

    for (const node of missingNodes) {
      try {
        const metadata = await this.resolveReferenceMetadata(node, template);
        if (!metadata) {
          continue;
        }

        node.title = metadata.title || node.title;
        node.previewText = metadata.abstract || node.previewText;
        this.metadataCache[node.cacheKey] = {
          title: node.title,
          abstract: node.previewText,
          identifiers: node.identifiers,
        };
        successCount += 1;
      } catch {
        continue;
      }
    }

    localStorage.setItem("reference-metadata-cache", JSON.stringify(this.metadataCache));
    this.buildGraphData();
    this.renderGraph();
    setResolverStatus(`Fetched metadata for ${successCount} of ${missingNodes.length} missing references.`);
  }

  async resolveReferenceMetadata(node, template) {
    const query = encodeURIComponent(node.title || node.raw || "");
    const url = template
      .replaceAll("{query}", query)
      .replaceAll("{title}", encodeURIComponent(node.title || ""))
      .replaceAll("{doi}", encodeURIComponent(node.identifiers?.doi || ""))
      .replaceAll("{arxivId}", encodeURIComponent(node.identifiers?.arxivId || ""));

    const response = await fetch(url);
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();

    if (contentType.includes("xml") || text.includes("<feed") || text.includes("<entry")) {
      const xml = new DOMParser().parseFromString(text, "application/xml");
      const entry = xml.querySelector("entry");
      if (!entry) {
        return null;
      }
      return {
        title: entry.querySelector("title")?.textContent?.trim() || node.title,
        abstract: entry.querySelector("summary")?.textContent?.trim() || "",
      };
    }

    if (contentType.includes("json")) {
      const data = JSON.parse(text);
      const candidate = Array.isArray(data.results) ? data.results[0] : data;
      return {
        title: candidate.title || node.title,
        abstract: candidate.abstract || candidate.summary || "",
      };
    }

    const html = new DOMParser().parseFromString(text, "text/html");
    return {
      title: html.querySelector("title")?.textContent?.trim() || node.title,
      abstract: html.querySelector('meta[name="description"]')?.getAttribute("content") || "",
    };
  }

  updateGraphSummary() {
    const uploaded = state.documents.length;
    const refs = this.graphData.nodes.filter((node) => !node.uploaded).length;
    this.elements.graphSummary.textContent = uploaded === 0
      ? "Open a PDF, then pop the graph open to map references."
      : `${uploaded} uploaded PDF${uploaded === 1 ? "" : "s"}, ${refs} referenced node${refs === 1 ? "" : "s"}. Click to expand the graph.`;
  }

  stopSimulation() {
    if (this.simulation) {
      this.simulation.stop();
      this.simulation = null;
    }
  }

  buildReferenceMeta(reference) {
    const parts = [];
    if (reference.identifiers?.arxivId) parts.push(`arXiv ${reference.identifiers.arxivId}`);
    if (reference.identifiers?.doi) parts.push("DOI");
    return parts.join(" · ") || "Referenced paper";
  }

  truncate(text, maxLength) {
    return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}...`;
  }

  escapeHtml(text) {
    return String(text || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  readStored(key, fallback) {
    const value = localStorage.getItem(key);
    if (!value) {
      return fallback;
    }

    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
}
