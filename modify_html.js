const fs = require("fs");
let html = fs.readFileSync("index.html", "utf8");

const t1 = `<div class="toolbar">
        <label class="file-picker">
          <input id="pdf-upload" type="file" accept="application/pdf" multiple>
          <span>Open PDFs</span>
        </label>
        <div class="mode-switch" role="tablist" aria-label="Application mode">
          <button id="mode-reader" class="mode-button is-active" type="button" role="tab" aria-selected="true">Reader</button>
          <button id="mode-graph" class="mode-button" type="button" role="tab" aria-selected="false">Knowledge Graph</button>
        </div>
        <button id="prev-page" class="ghost-button" type="button">Prev</button>
        <div class="page-indicator">
          <span id="current-page">0</span>
          <span>/</span>
          <span id="total-pages">0</span>
        </div>
        <button id="next-page" class="ghost-button" type="button">Next</button>
      </div>`;

html = html.replace(t1, "");

const t2 = `<div class="panel-card doc-panel">\r\n          <div class="panel-head">`;
const r2 = `<div class="panel-card doc-panel">\n          <label class="file-picker ghost-button doc-upload">\n            <input id="pdf-upload" type="file" accept="application/pdf" multiple>\n            <span>Open PDFs</span>\n          </label>\n          <div class="panel-head">`;
html = html.replace(t2, r2);
html = html.replace(`<div class="panel-card doc-panel">\n          <div class="panel-head">`, r2);

const t3 = `<section class="center-panel">\r\n        <div class="graph-ribbon">`;
const r3 = `<section class="center-panel">\n        <div class="center-toolbar">\n          <div class="mode-switch" role="tablist" aria-label="Application mode">\n            <button id="mode-reader" class="mode-button is-active" type="button" role="tab" aria-selected="true">Reader</button>\n            <button id="mode-graph" class="mode-button" type="button" role="tab" aria-selected="false">Knowledge Graph</button>\n          </div>\n          <div class="pagination-controls">\n            <button id="prev-page" class="ghost-button" type="button">Prev</button>\n            <div class="page-indicator">\n              <span id="current-page">0</span>\n              <span>/</span>\n              <span id="total-pages">0</span>\n            </div>\n            <button id="next-page" class="ghost-button" type="button">Next</button>\n          </div>\n        </div>\n        <div class="graph-ribbon">`;
html = html.replace(t3, r3);
html = html.replace(`<section class="center-panel">\n        <div class="graph-ribbon">`, r3);

const t4 = `  <div id="selection-toolbar" class="selection-toolbar hidden">\r\n    <button id="highlight-only" class="ghost-button" type="button">Highlight</button>\r\n    <button id="highlight-comment" class="solid-button" type="button">Highlight + Comment</button>\r\n  </div>`;
html = html.replace(t4, "");
const t4b = `  <div id="selection-toolbar" class="selection-toolbar hidden">\n    <button id="highlight-only" class="ghost-button" type="button">Highlight</button>\n    <button id="highlight-comment" class="solid-button" type="button">Highlight + Comment</button>\n  </div>`;
html = html.replace(t4b, "");

fs.writeFileSync("index.html", html, "utf8");
console.log("Modifications done");
