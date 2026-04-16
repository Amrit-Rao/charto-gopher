const fs = require('fs');
let code = fs.readFileSync('scripts/reader.js', 'utf8');

// 1. Remove highlightOnly and highlightComment event listeners
code = code.replace(/e\.highlightOnly\.addEventListener.*?\n/, '');
code = code.replace(/e\.highlightComment\.addEventListener.*?\n/, '');

// 2. Remove document mousedown listener for selectionToolbar
code = code.replace(/    document\.addEventListener\("mousedown", \(event\) => \{\r?\n      if \(\!e\.selectionToolbar\.contains\(event\.target\)\) \{\r?\n        this\.hideSelectionToolbar\(\);\r?\n      \}\r?\n    \}\);\r?\n/, '');

// 3. Remove this.hideSelectionToolbar(); from deactivate()
code = code.replace(/this\.hideSelectionToolbar\(\);\r?\n/, '');

// 4. Update handleTextSelection
const oldHandleTextSelection = `    const first = range.getBoundingClientRect();
    this.showSelectionToolbar(first.left + window.scrollX, first.top + window.scrollY - 52);`;
const newHandleTextSelection = `    this.commitSelection(false);`;
code = code.replace(oldHandleTextSelection, newHandleTextSelection);

// 5. Empty show/hide selection toolbar
const oldShow = `  showSelectionToolbar(x, y) {
    this.elements.selectionToolbar.classList.remove("hidden");
    this.elements.selectionToolbar.style.left = \`\${x}px\`;
    this.elements.selectionToolbar.style.top = \`\${Math.max(16, y)}px\`;
  }`;
code = code.replace(oldShow, '  showSelectionToolbar(x, y) {}');

const oldHide = `  hideSelectionToolbar() {
    this.elements.selectionToolbar.classList.add("hidden");
  }`;
code = code.replace(oldHide, '  hideSelectionToolbar() {}');

// 6. Remove this.hideSelectionToolbar(); in commitSelection
code = code.replace(/this\.hideSelectionToolbar\(\);\r?\n/, '');

// 7. Update comment box click behavior to open comment modal
const oldClickBehavior = `        if (comment) {
          box.addEventListener("click", (event) => {
            event.stopPropagation();
            this.focusComment(comment.id);
          });
        }`;
const newClickBehavior = `        box.addEventListener("click", (event) => {
          event.stopPropagation();
          if (comment) {
            this.focusComment(comment.id);
          } else {
            this.pendingSelection = {
              pageNumber: highlight.pageNumber,
              text: highlight.text,
              rects: highlight.rects
            };
            this.pendingHighlightWithComment = highlight.id;
            this.elements.modalContext.textContent = \`Page \${highlight.pageNumber} — \${highlight.text.slice(0, 120)}\`;
            this.elements.commentInput.value = "";
            this.elements.modal.classList.remove("hidden");
          }
        });`;
code = code.replace(oldClickBehavior, newClickBehavior);

fs.writeFileSync('scripts/reader.js', code, 'utf8');
console.log("reader.js modified");
