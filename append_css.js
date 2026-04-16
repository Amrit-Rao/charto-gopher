const fs = require('fs');
let css = fs.readFileSync('styles.css', 'utf8');

const overrides = `

/* OVERRIDES FOR RESIZABLE LAYOUT AND UI CLEANUP */
.workspace { 
  display: flex !important; 
  gap: 18px; 
  padding: 0 24px 24px; 
  flex: 1; 
  min-height: 0; 
  overflow: auto; 
}
.left-panel { 
  min-height: 0; 
  display: flex; 
  flex-direction: column; 
  gap: 16px; 
  width: 300px; 
  resize: horizontal; 
  overflow: auto; 
  min-width: 200px; 
  max-width: 50vw; 
}
.right-panel { 
  min-height: 0; 
  display: flex; 
  flex-direction: column; 
  gap: 16px; 
  width: 430px; 
  resize: horizontal; 
  overflow: auto; 
  min-width: 240px; 
  max-width: 50vw; 
  direction: rtl; 
}
.right-panel > * { 
  direction: ltr; 
}
.center-panel { 
  min-height: 0; 
  display: flex; 
  flex-direction: column; 
  gap: 16px; 
  flex: 1; 
  min-width: 300px; 
  overflow: hidden; 
}
.document-item strong { 
  white-space: normal !important; 
  display: -webkit-box !important; 
  -webkit-line-clamp: 2 !important; 
  -webkit-box-orient: vertical !important; 
  overflow: hidden !important; 
  text-overflow: ellipsis; 
}
.center-toolbar { 
  display: flex; 
  justify-content: space-between; 
  align-items: center; 
  background: var(--panel); 
  border: 1px solid var(--line); 
  border-radius: var(--radius); 
  padding: 10px 18px; 
  box-shadow: var(--shadow); 
  backdrop-filter: blur(16px); 
}
.pagination-controls { 
  display: flex; 
  align-items: center; 
  gap: 8px; 
}
.doc-upload {
  width: 100%;
  text-align: center;
  box-sizing: border-box;
}
`;

fs.writeFileSync('styles.css', css + overrides, 'utf8');
console.log("CSS Overrides injected");
