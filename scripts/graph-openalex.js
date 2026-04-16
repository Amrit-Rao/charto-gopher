import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import { fetchOutgoingReferences } from "./pdf-utils.js";
import { getCurrentDocument, setGraphSelection, setGraphStatus, setResolverStatus, state } from "./store.js";

export class GraphController {
  constructor(elements) {
    this.elements = elements;
    this.graphData = { nodes: [], links: [] };
    this.zoom = null;
    this.cache = new Map();
    this.attachEvents();
  }

  attachEvents() {
    this.elements.graphRibbonAction.addEventListener("click", () => document.getElementById("mode-graph").click());
    this.elements.fetchReferenceMetadata.addEventListener("click", () => this.tryResolverForMissing());
    this.elements.graphSelection.addEventListener("click", (event) => {
      const trigger = event.target.closest("[data-manual-upload]");
      if (trigger) {
        document.getElementById("pdf-upload").click();
      }
    });
  }

  async activate() {
    this.elements.graphPanel.classList.remove("hidden");
    this.elements.graphSidebar.classList.remove("hidden");
    if (!state.graphConfig.seedDocIds.length) {
      this.renderEmpty("Choose seed papers to build the graph.");
      return;
    }
    await this.buildGraph();
    this.renderGraph();
  }

  deactivate() {
    this.elements.graphPanel.classList.add("hidden");
    this.elements.graphSidebar.classList.add("hidden");
  }

  renderEmpty(message) {
    this.elements.graphEmptyState.classList.remove("hidden");
    this.elements.graphEmptyState.querySelector("p").textContent = message;
    this.elements.graphStage.classList.add("hidden");
    this.elements.graphSelection.innerHTML = "Select a node to inspect it.";
  }

  async buildGraph() {
    const seeds = state.documents.filter((doc) => state.graphConfig.seedDocIds.includes(doc.id) && doc.openAlex?.valid);
    if (!seeds.length) {
      this.renderEmpty("No valid seed papers are available. Invalid PDFs must be fixed or replaced first.");
      return;
    }

    setGraphStatus(`Building graph from ${seeds.length} seed paper${seeds.length === 1 ? "" : "s"} at depth ${state.graphConfig.depth}...`);

    const nodes = [];
    const links = [];
    const nodeMap = new Map();
    const queue = [];
    const visited = new Map();

    const ensureNode = (payload) => {
      if (!nodeMap.has(payload.id)) {
        nodeMap.set(payload.id, payload);
        nodes.push(payload);
      }
      return nodeMap.get(payload.id);
    };

    for (const seed of seeds) {
      const work = this.normalizeWork(seed.openAlex.work);
      ensureNode({
        id: work.id,
        docId: seed.id,
        title: seed.title,
        uploaded: true,
        previewImage: seed.firstPagePreview,
        previewText: seed.abstract,
        sourceUrl: work.sourceUrl,
        level: 0,
        meta: seed.title,
      });
      queue.push({ work, level: 0 });
      visited.set(work.id, 0);
    }

    while (queue.length > 0) {
      const current = queue.shift();
      if (current.level >= state.graphConfig.depth) {
        continue;
      }

      const refs = await this.getReferences(current.work.id);
      for (const ref of refs) {
        const uploadedDoc = state.documents.find((doc) => doc.openAlex?.valid && doc.openAlex.work.id === ref.id);
        ensureNode({
          id: ref.id,
          docId: uploadedDoc?.id || null,
          title: uploadedDoc?.title || ref.title,
          uploaded: Boolean(uploadedDoc),
          previewImage: uploadedDoc?.firstPagePreview || "",
          previewText: uploadedDoc?.abstract || ref.abstract,
          sourceUrl: ref.sourceUrl || `https://api.openalex.org/works/${ref.id.split("/").at(-1)}`,
          level: current.level + 1,
          meta: `${ref.publicationYear || ""}${ref.referencedWorksCount ? ` · ${ref.referencedWorksCount} refs` : ""}`,
        });
        links.push({ source: current.work.id, target: ref.id });
        if (!visited.has(ref.id) || visited.get(ref.id) > current.level + 1) {
          visited.set(ref.id, current.level + 1);
          if (current.level + 1 < state.graphConfig.depth) {
            queue.push({ work: ref, level: current.level + 1 });
          }
        }
      }
    }

    this.graphData = { nodes, links };
    setGraphStatus(`Graph ready: ${nodes.length} nodes, ${links.length} links.`);
  }

  async getReferences(workId) {
    if (!this.cache.has(workId)) {
      this.cache.set(workId, await fetchOutgoingReferences(workId));
    }
    return this.cache.get(workId);
  }

  renderGraph() {
    if (!this.graphData.nodes.length) {
      this.renderEmpty("No graph nodes were produced from the selected papers.");
      return;
    }

    this.elements.graphEmptyState.classList.add("hidden");
    this.elements.graphStage.classList.remove("hidden");
    const nodeLayer = this.elements.graphNodes;
    const edgeGroup = this.elements.graphEdgesGroup;
    nodeLayer.innerHTML = "";
    edgeGroup.innerHTML = "";

    const width = this.elements.graphStage.clientWidth || 900;
    const height = this.elements.graphStage.clientHeight || 680;
    this.elements.graphEdges.setAttribute("viewBox", `0 0 ${width} ${height}`);

    const levels = new Map();
    this.graphData.nodes.forEach((node) => {
      if (!levels.has(node.level)) {
        levels.set(node.level, []);
      }
      levels.get(node.level).push(node);
    });

    const centerX = width / 2;
    const centerY = height / 2;
    [...levels.entries()].forEach(([level, levelNodes]) => {
      const radius = 80 + level * 220;
      levelNodes.forEach((node, index) => {
        const angle = (Math.PI * 2 * index) / Math.max(levelNodes.length, 1);
        node.x = level === 0 ? centerX : centerX + Math.cos(angle) * radius;
        node.y = level === 0 ? centerY : centerY + Math.sin(angle) * radius;
      });
    });

    this.graphData.links.forEach((link) => {
      const source = this.graphData.nodes.find((node) => node.id === link.source);
      const target = this.graphData.nodes.find((node) => node.id === link.target);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", source.x);
      line.setAttribute("y1", source.y);
      line.setAttribute("x2", target.x);
      line.setAttribute("y2", target.y);
      line.setAttribute("stroke", "rgba(125, 99, 66, 0.28)");
      line.setAttribute("stroke-width", "1.4");
      edgeGroup.appendChild(line);
    });

    this.graphData.nodes.forEach((node) => {
      const card = document.createElement("div");
      card.className = `graph-node${node.uploaded ? " is-uploaded" : " is-missing"}`;
      if (node.id === state.graphSelectionId) {
        card.classList.add("is-active");
      }
      card.style.left = `${node.x}px`;
      card.style.top = `${node.y}px`;
      card.innerHTML = `
        <div class="graph-node-top">
          <div>
            <h3 class="graph-node-title">${this.escape(node.title)}</h3>
            <div class="graph-node-meta">${this.escape(node.meta || "")}</div>
          </div>
          <div>${node.uploaded ? '<span class="node-chip">PDF</span>' : '<span class="node-missing">!</span>'}</div>
        </div>
        <div class="graph-node-preview">${node.previewImage ? `<img src="${node.previewImage}" alt="${this.escape(node.title)}">` : `<p>${this.escape((node.previewText || "No preview available.").slice(0, 260))}</p>`}</div>
      `;
      card.addEventListener("mouseenter", () => this.renderSelection(node));
      card.addEventListener("click", () => {
        setGraphSelection(node.id);
        this.renderGraph();
        this.renderSelection(node);
      });
      nodeLayer.appendChild(card);
    });

    this.enableZoomPan();
    const selected = this.graphData.nodes.find((node) => node.id === state.graphSelectionId) || this.graphData.nodes[0];
    if (selected) {
      this.renderSelection(selected);
    }
  }

  enableZoomPan() {
    const svg = d3.select(this.elements.graphEdges);
    const nodes = d3.select(this.elements.graphNodes);
    if (!this.zoom) {
      this.zoom = d3.zoom().scaleExtent([0.4, 2.5]).on("zoom", (event) => {
        d3.select(this.elements.graphEdgesGroup).attr("transform", event.transform);
        nodes.style("transform", `translate(${event.transform.x}px, ${event.transform.y}px) scale(${event.transform.k})`);
      });
      svg.call(this.zoom);
    }
  }

  async tryResolverForMissing() {
    const template = this.elements.resolverTemplate.value.trim();
    const missingNode = this.graphData.nodes.find((node) => !node.uploaded);
    if (!missingNode || !template) {
      setResolverStatus("No missing nodes or resolver template available.");
      return;
    }
    const response = await fetch(template.replaceAll("{query}", encodeURIComponent(missingNode.title)));
    setResolverStatus(`Resolver responded with ${response.status}. You can inspect the URL from the selected node panel.`);
  }

  renderSelection(node) {
    this.elements.graphSelection.innerHTML = `
      <strong>${this.escape(node.title)}</strong>
      <p>${this.escape(node.uploaded ? "Uploaded and matched to OpenAlex" : "Missing locally. Found only in the knowledge graph.")}</p>
      <p>${this.escape(node.previewText || "No abstract available.")}</p>
      <p><a href="${node.sourceUrl}" target="_blank" rel="noreferrer">Open source / curl URL</a></p>
      ${node.uploaded ? "" : '<p><button type="button" class="ghost-button" data-manual-upload="true">Upload matching PDF manually</button></p>'}
      ${node.previewImage ? `<img src="${node.previewImage}" alt="${this.escape(node.title)}">` : ""}
    `;
  }

  updateGraphSummary() {
    const current = getCurrentDocument();
    const seedCount = state.graphConfig.seedDocIds.length;
    this.elements.graphSummary.textContent = current
      ? `${current.title} · graph configured with ${seedCount} seed paper${seedCount === 1 ? "" : "s"} at depth ${state.graphConfig.depth}.`
      : "Open a PDF, then pop the graph open to map references.";
  }

  normalizeWork(work) {
    return { id: work.id, title: work.display_name || work.title || "Untitled", sourceUrl: work.id };
  }

  escape(value) {
    return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }
}
