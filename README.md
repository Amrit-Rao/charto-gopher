# PDF Reader Prototype

A browser prototype for reading PDFs, annotating selected text, and expanding a citation graph through OpenAlex.

## Current capabilities

- upload multiple PDFs
- validate uploaded papers against OpenAlex when possible
- show invalid PDFs with an error state instead of assuming they are correct
- highlight selected text and optionally attach comments to that highlight
- reveal comment popovers only when hovering the highlighted region
- click a highlighted region to jump to the matching comment in the sidebar
- remove uploaded PDFs from the workspace
- build a knowledge graph from up to 3 seed papers and a chosen depth
- expand graph references using OpenAlex instead of the old PDF reference heuristic
- distinguish uploaded nodes from missing nodes, and grey missing nodes out with `!`
- pan and zoom around the graph

## Run locally

```powershell
cd D:\Research\pdf-reader-prototype
python -m http.server 4173
```

Open `http://localhost:4173`.

## Important notes

- The graph now depends on OpenAlex API lookups, so internet access in the browser matters.
- Validation is title/DOI based and intentionally conservative; uncertain matches are shown as invalid rather than silently accepted.
- Graph mode asks for seed papers and depth each time you open it.
