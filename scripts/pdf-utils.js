const OPENALEX_BASE = "https://api.openalex.org";

export function buildDocumentKey(file) {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

export async function loadPdfDescriptor(file, pdfjsLib) {
  const bytes = await file.arrayBuffer();
  const pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
  const metadata = await pdfDoc.getMetadata().catch(() => null);
  const firstPageText = await extractPageText(pdfDoc, 1);
  const identifiers = extractIdentifiers(`${firstPageText}\n${file.name}`);
  const title = inferTitle(metadata?.info?.Title, firstPageText, file.name);
  const abstract = inferAbstract(firstPageText);
  const openAlex = await validateWithOpenAlex({ title, identifiers });

  return {
    pdfDoc,
    metadata,
    title,
    abstract,
    firstPagePreview: await renderPagePreview(pdfDoc, 1, 220),
    identifiers,
    openAlex,
  };
}

export async function validateWithOpenAlex({ title, identifiers }) {
  if (identifiers.doi) {
    try {
      const response = await fetch(`${OPENALEX_BASE}/works/doi:${identifiers.doi}`);
      if (response.ok) {
        const work = await response.json();
        return { valid: true, confidence: 1, work };
      }
    } catch {}
  }

  const response = await fetch(`${OPENALEX_BASE}/works/doi:${identifiers.doi}?&select=id,display_name,doi,referenced_works_count,publication_year,authorships,abstract_inverted_index`);
  const data = await response.json();
  const candidates = data.results || [];
  const scored = candidates.map((candidate) => ({
    candidate,
    score: similarity(normalizeTitle(candidate.display_name || ""), normalizeTitle(title)),
  })).sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < 0.72) {
    return {
      valid: false,
      confidence: best?.score || 0,
      error: `Could not confidently match this PDF to OpenAlex for graph expansion.`
    };
  }

  return {
    valid: true,
    confidence: best.score,
    work: best.candidate,
  };
}

export async function fetchOutgoingReferences(workId) {
  const shortId = workId.split("/").at(-1);
  const response = await fetch(`${OPENALEX_BASE}/works/${shortId}`);
  const data = await response.json();
  if (!data || !data.referenced_works || data.referenced_works.length === 0) {
    return [];
  }
  
  const refIds = data.referenced_works.map((url) => url.split("/").at(-1));
  const chunkedIds = [];
  for (let i = 0; i < refIds.length; i += 50) {
    chunkedIds.push(refIds.slice(i, i + 50));
  }
  
  let allResults = [];
  for (const chunk of chunkedIds) {
    const filterStr = `openalex:${chunk.join("|")}`;
    const chunkRes = await fetch(`${OPENALEX_BASE}/works?filter=${filterStr}&per-page=50&select=id,display_name,doi,ids,referenced_works_count,publication_year,abstract_inverted_index,primary_location`);
    const chunkData = await chunkRes.json();
    if (chunkData.results) {
      allResults = allResults.concat(chunkData.results.map(normalizeOpenAlexWork));
    }
  }
  return allResults;
}

export function normalizeOpenAlexWork(work) {
  return {
    id: work.id,
    title: work.display_name || "Untitled work",
    abstract: abstractFromInvertedIndex(work.abstract_inverted_index),
    ids: work.ids || {},
    doi: work.doi || work.ids?.doi || "",
    openAlexId: work.id,
    referencedWorksCount: work.referenced_works_count || 0,
    publicationYear: work.publication_year || "",
    sourceUrl: work.primary_location?.landing_page_url || work.primary_location?.pdf_url || work.id,
  };
}

export async function extractPageText(pdfDoc, pageNumber) {
  const page = await pdfDoc.getPage(pageNumber);
  const content = await page.getTextContent();
  let text = "";
  for (const item of content.items) {
    text += item.str || "";
    text += item.hasEOL ? "\n" : " ";
  }
  return text.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
}

export async function renderPagePreview(pdfDoc, pageNumber, maxWidth = 220) {
  const page = await pdfDoc.getPage(pageNumber);
  const initialViewport = page.getViewport({ scale: 1 });
  const scale = maxWidth / initialViewport.width;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas.toDataURL("image/png", 0.86);
}

function inferTitle(metadataTitle, firstPageText, fileName) {
  if (metadataTitle && metadataTitle.trim() && metadataTitle.trim().toLowerCase() !== "untitled") {
    return metadataTitle.trim();
  }
  const lines = firstPageText.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => line.length > 18 && line.length < 180 && !/abstract/i.test(line)) || fileName.replace(/\.pdf$/i, "");
}

function inferAbstract(firstPageText) {
  const abstractMatch = firstPageText.match(/abstract\s*[:.]?\s*([\s\S]{80,1200})/i);
  if (!abstractMatch) {
    return firstPageText.slice(0, 420);
  }
  return abstractMatch[1].split(/\n\s*\n|1\s+introduction/i)[0].slice(0, 700).trim();
}

function extractIdentifiers(text) {
  const doiRegex = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+(?=[^._;()/:A-Z0-9]|$)/gi;
  
  // Improved ArXiv: Handles old and new formats
  const arxivRegex = /(?:arxiv:|[/\s])(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z-]+)?\/\d{7})/gi;

  const doiMatches = text.match(doiRegex);
  const arxivMatches = text.match(arxivRegex);

  // Clean up the ArXiv match to remove the "arxiv:" prefix if present
  const cleanArxiv = (match) => match ? match.replace(/arxiv:\s*/i, "").trim() : "";

  return {
    doi: doiMatches ? doiMatches[0].toLowerCase().replace(/[.,]$/, "") : "",
    arxivId: arxivMatches ? cleanArxiv(arxivMatches[0]) : "",
  };
}

function abstractFromInvertedIndex(index) {
  if (!index) {
    return "";
  }
  const words = [];
  Object.entries(index).forEach(([word, positions]) => {
    positions.forEach((position) => {
      words[position] = word;
    });
  });
  return words.filter(Boolean).join(" ");
}

export function normalizeTitle(value) {
  return (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(a, b) {
  if (!a || !b) {
    return 0;
  }
  if (a === b) {
    return 1;
  }
  const aWords = new Set(a.split(" "));
  const bWords = new Set(b.split(" "));
  const overlap = [...aWords].filter((word) => bWords.has(word)).length;
  return overlap / Math.max(aWords.size, 1);
}
