import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import { fetchOutgoingReferences } from "./pdf-utils.js";
import { getCurrentDocument, setGraphSelection, setGraphStatus, setResolverStatus, state, updateGraphNodeMeta } from "./store.js";

export class GraphController {
  constructor(elements) {
    this.elements = elements;
    this.graphData = { nodes: [], links: [] };
    this.cache = new Map();
    this.simulation = null;
    this.zoom = null;
    this.currentTransform = d3.zoomIdentity;
    this.activeContextMenuNodeId = null;
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

    if (this.elements.resetGraphLayout) {
       this.elements.resetGraphLayout.addEventListener("click", () => this.resetLayout());
    }

    if (this.elements.graphNodeNotes) {
      this.elements.graphNodeNotes.addEventListener("input", (e) => {
        if (!state.graphSelectionId) return;
        updateGraphNodeMeta(state.graphSelectionId, { note: e.target.value });
      });
    }

    if (this.elements.graphNodeColors) {
      this.elements.graphNodeColors.addEventListener("click", (e) => {
        if (!state.graphSelectionId) return;
        const btn = e.target.closest(".color-swatch-btn");
        if (!btn) return;
        updateGraphNodeMeta(state.graphSelectionId, { color: btn.getAttribute("data-color") });
        this.updateNodeStyles();
      });
    }

    if (this.elements.contextNodeColors) {
      this.elements.contextNodeColors.addEventListener("click", (e) => {
         if (!this.activeContextMenuNodeId) return;
         const btn = e.target.closest(".color-swatch-btn");
         if (!btn) return;
         updateGraphNodeMeta(this.activeContextMenuNodeId, { color: btn.getAttribute("data-color") });
         this.updateNodeStyles();
         this.closeContextMenu();
      });
    }

    if (this.elements.contextDownloadBtn) {
      this.elements.contextDownloadBtn.addEventListener("click", () => {
         if (!this.activeContextMenuNodeId) return;
         const node = this.graphData.nodes.find(n => n.id === this.activeContextMenuNodeId);
         if (!node) return;
         const url = prompt("Confirm or enter URL to download:", node.sourceUrl);
         if (url) {
            window.open(url, "_blank");
         }
         this.closeContextMenu();
      });
    }

    if (this.elements.graphZoomIn) {
      this.elements.graphZoomIn.addEventListener("click", () => this.zoomBy(1.3));
    }
    if (this.elements.graphZoomOut) {
      this.elements.graphZoomOut.addEventListener("click", () => this.zoomBy(0.7));
    }
    if (this.elements.graphZoomReset) {
      this.elements.graphZoomReset.addEventListener("click", () => this.resetZoom());
    }

    document.addEventListener("click", (e) => {
      if (this.elements.graphContextMenu && !this.elements.graphContextMenu.classList.contains("hidden")) {
         if (!this.elements.graphContextMenu.contains(e.target)) {
            this.closeContextMenu();
         }
      }
    });
  }

  async activate() {
    this.elements.graphPanel.classList.remove("hidden");
    this.elements.graphSidebar.classList.remove("hidden");
    if (this.elements.graphNodeMetaControls) {
       this.elements.graphNodeMetaControls.classList.remove("hidden");
    }
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
    if (this.simulation) this.simulation.stop();
  }

  renderEmpty(message) {
    this.elements.graphEmptyState.classList.remove("hidden");
    this.elements.graphEmptyState.querySelector("p").textContent = message;
    this.elements.graphStage.classList.add("hidden");
    this.elements.graphSelection.innerHTML = "Select a node to inspect it.";
    if (this.elements.graphNodeMetaControls) {
       this.elements.graphNodeMetaControls.classList.add("hidden");
    }
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

      const refs = await this.getReferences(current.work.id, state.graphConfig.maxRefs || 5);
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
          meta: `${ref.publicationYear || ""}${ref.referencedWorksCount ? ` – ${ref.referencedWorksCount} refs` : ""}`,
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

  async getReferences(workId, maxRefs) {
    const key = `${workId}-${maxRefs}`;
    if (!this.cache.has(key)) {
      this.cache.set(key, await fetchOutgoingReferences(workId, maxRefs));
    }
    return this.cache.get(key);
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

    // Use full base canvas
    const width = Math.max(this.elements.graphStage.clientWidth, 2400) || 2400;
    const height = Math.max(this.elements.graphStage.clientHeight, 2400) || 2400;
    this.elements.graphEdges.style.width = "100%";
    this.elements.graphEdges.style.height = "100%";
    nodeLayer.style.width = "100%";
    nodeLayer.style.height = "100%";
    
    // Position roughly matching container center
    const stageWidth = this.elements.graphStage.clientWidth || 900;
    const stageHeight = this.elements.graphStage.clientHeight || 680;
    const centerX = stageWidth / 2;
    const centerY = stageHeight / 2;

    const seeds = this.graphData.nodes.filter(n => n.level === 0);
    seeds.forEach((node, i) => {
      if (node.x === undefined) {
         const angle = (Math.PI * 2 * i) / Math.max(seeds.length, 1);
         node.fx = centerX + Math.cos(angle) * (seeds.length > 1 ? 480 : 0);
         node.fy = centerY + Math.sin(angle) * (seeds.length > 1 ? 480 : 0);
         node.x = node.fx; 
         node.y = node.fy;
      }
    });

    const edgeSelection = d3.select(edgeGroup)
      .selectAll("line")
      .data(this.graphData.links, d => `${d.source.id || d.source}-${d.target.id || d.target}`)
      .join("line")
      .attr("stroke", "rgba(125, 99, 66, 0.28)")
      .attr("stroke-width", "1.4");

    const nodeSelection = d3.select(nodeLayer)
      .selectAll("div.graph-node")
      .data(this.graphData.nodes, d => d.id)
      .join(
        enter => {
          const card = enter.append("div")
            .attr("class", d => `graph-node${d.uploaded ? " is-uploaded" : " is-missing"}`)
            .html(d => `
              <div class="graph-node-top">
                <div>
                  <h3 class="graph-node-title">${this.escape(d.title)}</h3>
                  <div class="graph-node-meta">${this.escape(d.meta || "")}</div>
                </div>
                <div>${d.uploaded ? '<span class="node-chip">PDF</span>' : '<span class="node-missing">!</span>'}</div>
              </div>
              <div class="graph-node-preview">${d.previewImage ? `<img src="${d.previewImage}" alt="preview">` : `<p>${this.escape((d.previewText || "No abstract available.").slice(0, 160))}</p>`}</div>
            `);

          card.on("click", (event, d) => {
            if (event.defaultPrevented) return;
            setGraphSelection(d.id);
            this.renderSelection(d);
            this.updateNodeStyles();
          });

          card.on("contextmenu", (event, d) => {
             event.preventDefault();
             event.stopPropagation();
             this.openContextMenu(event, d.id);
          });
          
          card.call(d3.drag()
            .on("start", (event, d) => {
              if (!event.active && this.simulation) this.simulation.alphaTarget(0.3).restart();
              d.fx = d.x;
              d.fy = d.y;
            })
            .on("drag", (event, d) => {
              // Apply physics anchor delta perfectly dividing out the container scaled zoom
              d.fx += event.dx / this.currentTransform.k;
              d.fy += event.dy / this.currentTransform.k;
            })
            .on("end", (event, d) => {
              if (!event.active && this.simulation) this.simulation.alphaTarget(0);
            })
          );
          return card;
        }
      );

    if (this.simulation) this.simulation.stop();
    this.simulation = d3.forceSimulation(this.graphData.nodes)
      .force("link", d3.forceLink(this.graphData.links).id(d => d.id).distance(240))
      .force("charge", d3.forceManyBody().strength(-1800))
      .force("collide", d3.forceCollide().radius(d => d.uploaded ? 160 : 130).iterations(3))
      .on("tick", () => {
         edgeSelection
           .attr("x1", d => d.source.x)
           .attr("y1", d => d.source.y)
           .attr("x2", d => d.target.x)
           .attr("y2", d => d.target.y);
         nodeSelection
           .style("left", d => `${d.x}px`)
           .style("top", d => `${d.y}px`);
      });

    this.updateNodeStyles();
    this.enableZoomPan();

    const selected = this.graphData.nodes.find((node) => node.id === state.graphSelectionId) || this.graphData.nodes[0];
    if (selected) {
      if (!state.graphSelectionId) setGraphSelection(selected.id);
      this.renderSelection(selected);
    }
  }

  enableZoomPan() {
    if (!this.zoom) {
      this.zoom = d3.zoom()
        .scaleExtent([0.1, 4.0])
        .on("zoom", (event) => {
          this.currentTransform = event.transform;
          d3.select(this.elements.graphEdgesGroup).attr("transform", event.transform);
          d3.select(this.elements.graphNodes).style("transform", `translate(${event.transform.x}px, ${event.transform.y}px) scale(${event.transform.k})`);
        });
      d3.select(this.elements.graphStage).call(this.zoom).on("dblclick.zoom", null);
    }
  }

  zoomBy(factor) {
    if (!this.zoom) return;
    d3.select(this.elements.graphStage).transition().duration(250).call(this.zoom.scaleBy, factor);
  }

  resetZoom() {
    if (!this.zoom) return;
    d3.select(this.elements.graphStage).transition().duration(500).call(this.zoom.transform, d3.zoomIdentity);
  }

  openContextMenu(event, nodeId) {
    this.activeContextMenuNodeId = nodeId;
    const menu = this.elements.graphContextMenu;
    if (!menu) return;
    
    setGraphSelection(nodeId);
    this.renderSelection(this.graphData.nodes.find(n => n.id === nodeId));
    this.updateNodeStyles();

    menu.classList.remove("hidden");
    let x = event.clientX;
    let y = event.clientY;
    
    if (x + 200 > window.innerWidth) x -= 200;
    if (y + 150 > window.innerHeight) y -= 150;

    menu.style.left = '${x}px';
    menu.style.top = '${y}px';
  }

  closeContextMenu() {
    if (this.elements.graphContextMenu) {
      this.elements.graphContextMenu.classList.add("hidden");
    }
    this.activeContextMenuNodeId = null;
  }

  resetLayout() {
    const stageWidth = this.elements.graphStage.clientWidth || 900;
    const stageHeight = this.elements.graphStage.clientHeight || 680;
    const centerX = stageWidth / 2;
    const centerY = stageHeight / 2;
    
    const seeds = this.graphData.nodes.filter(n => n.level === 0);
    this.graphData.nodes.forEach(node => {
      node.fx = null;
      node.fy = null;
    });
    
    seeds.forEach((node, i) => {
       const angle = (Math.PI * 2 * i) / Math.max(seeds.length, 1);
       node.fx = centerX + Math.cos(angle) * (seeds.length > 1 ? 480 : 0);
       node.fy = centerY + Math.sin(angle) * (seeds.length > 1 ? 480 : 0);
       node.vx = 0; node.vy = 0;
    });
    
    if (this.simulation) {
       this.simulation.alpha(1).restart();
    }
  }

  updateNodeStyles() {
    const nodes = this.elements.graphNodes.querySelectorAll('.graph-node');
    nodes.forEach(nodeEl => {
       const d = d3.select(nodeEl).datum();
       if (!d) return;
       nodeEl.classList.toggle('is-active', d.id === state.graphSelectionId);
       
       const meta = state.graphNodeMeta[d.id] || {};
       if (meta.color && meta.color !== 'default') {
          nodeEl.style.backgroundColor = meta.color;
          nodeEl.style.borderColor = "rgba(0,0,0,0.1)";
       } else {
          nodeEl.style.backgroundColor = '';
          nodeEl.style.borderColor = '';
       }
    });

    if (state.graphSelectionId && this.elements.graphNodeNotes) {
       const meta = state.graphNodeMeta[state.graphSelectionId] || {};
       this.elements.graphNodeNotes.value = meta.note || "";
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
    if (this.elements.graphSelection) {
      this.elements.graphSelection.innerHTML = `
        <strong>${this.escape(node.title)}</strong>
        <p>${this.escape(node.uploaded ? "Uploaded and matched to OpenAlex" : "Missing locally. Found only in the knowledge graph.")}</p>
        <p>${this.escape(node.previewText || "No abstract available.")}</p>
        <p><a href="${node.sourceUrl}" target="_blank" rel="noreferrer">Open source / curl URL</a></p>
        ${node.uploaded ? "" : '<p><button type="button" class="ghost-button" data-manual-upload="true">Upload matching PDF manually</button></p>'}
        ${node.previewImage ? `<img src="${node.previewImage}" alt="preview">` : ""}
      `;
    }
    if (this.elements.graphNodeMetaControls) {
      this.elements.graphNodeMetaControls.classList.remove("hidden");
    }
  }

  updateGraphSummary() {
    const current = getCurrentDocument();
    const seedCount = state.graphConfig.seedDocIds.length;
    this.elements.graphSummary.textContent = current
      ? `${current.title} – graph configured with ${seedCount} seed paper${seedCount === 1 ? "" : "s"} at depth ${state.graphConfig.depth}.`
      : "Open a PDF, then pop the graph open to map references.";
  }

  normalizeWork(work) {
    return { id: work.id, title: work.display_name || work.title || "Untitled", sourceUrl: work.id };
  }

  escape(value) {
    return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }
}
