/**
 * Reading a PDF's own text: pages → lines → sections of label/value rows, tables and paragraphs, each
 * item keeping its page and the exact line text it came from (the evidence a citation quotes).
 *
 *  - Text comes from the PDF's text layer (pdfjs-dist, no rendering, no eval). A page with no text but an
 *    image is reported as NO_TEXT_LAYER (a scan): OCR is not available here, so its contents are never guessed.
 *  - Layout is read from positions and fonts, not from known field names: a bold single line in a larger size
 *    is a heading; a bold label followed by a value is a label/value row; a row of bold cells starts a table
 *    whose columns are the header cells' x positions; wrapped cells and labels are joined to their row.
 *  - Lines repeated on every page (banners, watermarks, footers with page numbers) are taken out of the
 *    content and kept as banners, since they often say what the document is ("illustrative demo document").
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export const EXTRACTION_PIPELINE = 'pdf-layout-2';
export const EXTRACTION = Object.freeze({ SUCCESS: 'SUCCESS', PARTIAL: 'PARTIAL', FAILED: 'FAILED' });
export const PAGE = Object.freeze({ TEXT: 'TEXT', NO_TEXT_LAYER: 'NO_TEXT_LAYER', EMPTY: 'EMPTY', ERROR: 'ERROR' });

const MAX_BYTES = 25_000_000;
const MAX_PAGES = 80;
const BOLD = /bold|black|heavy|semibold|demi/i;

let pdfjs = null;
const standardFonts = (() => {
  try { return `${join(dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'standard_fonts')}/`; } catch { return undefined; }
})();
async function loadPdfjs() {
  pdfjs ??= await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs;
}

/** "D:20261124082145+00'00'" → ISO; anything else → null. */
export function pdfDate(value) {
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(String(value ?? ''));
  if (!m) return null;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00'] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * The text of a PDF, page by page, as positioned lines of cells.
 * @param {Uint8Array} bytes
 * @returns {Promise<{status, pageCount, metadata, pages: {page, status, lines: {y, cells: {x, text, bold, size}[], text}[]}[], errors: string[]}>}
 */
export async function extractPdfText(bytes, { maxBytes = MAX_BYTES, maxPages = MAX_PAGES } = {}) {
  const errors = [];
  // A plain Uint8Array copy (pdfjs refuses a Buffer, and detaches what it is given).
  const data = new Uint8Array(bytes ?? []);
  if (!data.length) return failed('The file is empty.');
  if (data.length > maxBytes) return failed(`The file is ${Math.round(data.length / 1e6)} MB, over the ${Math.round(maxBytes / 1e6)} MB limit for reading.`);
  if (String.fromCharCode(...data.slice(0, 5)) !== '%PDF-') return failed('The file is not a PDF (no %PDF header).');
  const { getDocument } = await loadPdfjs();
  let doc;
  try {
    doc = await getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0, standardFontDataUrl: standardFonts }).promise;
  } catch (error) {
    return failed(`The PDF could not be opened: ${error?.message ?? error}`);
  }
  try {
    let metadata = {};
    try {
      const { info } = await doc.getMetadata();
      metadata = { title: info?.Title || null, author: info?.Author || null, subject: info?.Subject || null, createdAt: pdfDate(info?.CreationDate), modifiedAt: pdfDate(info?.ModDate) };
    } catch { /* no metadata */ }
    const pages = [];
    const count = Math.min(doc.numPages, maxPages);
    if (doc.numPages > maxPages) errors.push(`Only the first ${maxPages} of ${doc.numPages} pages were read.`);
    for (let n = 1; n <= count; n += 1) {
      try { pages.push(await readPage(await doc.getPage(n), n)); } catch (error) {
        pages.push({ page: n, status: PAGE.ERROR, lines: [], error: String(error?.message ?? error) });
        errors.push(`Page ${n} could not be read: ${error?.message ?? error}`);
      }
    }
    const readable = pages.filter(p => p.status === PAGE.TEXT).length;
    const status = readable === 0 ? EXTRACTION.FAILED : readable < pages.length || doc.numPages > maxPages ? EXTRACTION.PARTIAL : EXTRACTION.SUCCESS;
    if (!readable) errors.push(pages.some(p => p.status === PAGE.NO_TEXT_LAYER) ? 'No page has a text layer (a scanned document); OCR is not available, so its contents were not read.' : 'No readable text was found.');
    return { status, pageCount: doc.numPages, metadata, pages, errors };
  } finally {
    await doc.destroy().catch(() => {});
  }

  function failed(message) { return { status: EXTRACTION.FAILED, pageCount: 0, metadata: {}, pages: [], errors: [message] }; }
}

async function readPage(page, n) {
  const content = await page.getTextContent();
  // Fonts are named once the page's operators are read (to tell bold labels and headings from values).
  let ops = null;
  try { ops = await page.getOperatorList(); } catch { /* fonts unknown: no bold */ }
  const fontName = id => { try { return page.commonObjs.has(id) ? page.commonObjs.get(id)?.name ?? '' : ''; } catch { return ''; } };
  const items = content.items.filter(it => typeof it.str === 'string' && it.str.trim()).map(it => ({
    x: it.transform[4], y: it.transform[5], w: it.width ?? 0, size: Math.abs(it.transform[0]) || it.height || 10,
    text: it.str.replace(/\s+/g, ' ').trim(), bold: BOLD.test(fontName(it.fontName)),
  }));
  if (!items.length) {
    const images = ops ? ops.fnArray.filter(fn => [pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject].includes(fn)).length : 0;
    return { page: n, status: images ? PAGE.NO_TEXT_LAYER : PAGE.EMPTY, lines: [] };
  }
  const [, y0 = 0, , y1 = 842] = page.view ?? [];
  return { page: n, status: PAGE.TEXT, bottom: y0, top: y1, lines: toLines(items) };
}

/** Items on (about) the same baseline form a line; touching items of the same style form one cell. */
export function toLines(items) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const line = lines.at(-1);
    if (line && Math.abs(line.y - it.y) <= 2.5) line.items.push(it); else lines.push({ y: it.y, items: [it] });
  }
  return lines.map(line => {
    const cells = [];
    for (const it of line.items.sort((a, b) => a.x - b.x)) {
      const last = cells.at(-1);
      if (last && it.x - (last.x + last.w) <= it.size * 0.9 && last.bold === it.bold) {
        last.text = `${last.text}${it.x - (last.x + last.w) > it.size * 0.15 ? ' ' : ''}${it.text}`;
        last.w = it.x + it.w - last.x;
      } else cells.push({ ...it });
    }
    const out = cells.map(c => ({ x: Math.round(c.x * 10) / 10, w: Math.round(c.w * 10) / 10, text: c.text, bold: c.bold, size: Math.round(c.size * 10) / 10 }));
    return { y: Math.round(line.y * 10) / 10, cells: out, text: out.map(c => c.text).join(' | ') };
  });
}

const PAGE_NUMBER = /\bpage \d+ (of|\/) \d+\b|^\d+ ?\/ ?\d+$|^- ?\d+ ?-$/i;
// A banner repeats with the same text (page numbers aside) at the same place on the page.
const shape = line => `${line.text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()}@${Math.round(line.y / 12)}`;

/**
 * Sections of a document from its lines.
 * @returns {{title, banners: {text, page}[], sections: {heading, group, page, kv, tables, paragraphs}[]}}
 */
export function layoutDocument(extraction) {
  const pages = extraction.pages.filter(p => p.status === PAGE.TEXT);
  // Lines repeated (same shape) on two or more pages, or carrying a page number, are banners and footers.
  const seen = new Map();
  for (const p of pages) for (const shapeKey of new Set(p.lines.map(shape))) seen.set(shapeKey, (seen.get(shapeKey) ?? 0) + 1);
  const repeated = key => pages.length > 1 && seen.get(key) >= 2;
  const banners = [];
  const bannerSeen = new Set();
  const lines = [];
  for (const p of pages) {
    for (const l of p.lines) {
      const key = shape(l);
      // Repeated on every page, a page number, or in the top or bottom margin (a one-page document's header and footer).
      const margin = p.top !== undefined && (l.y > p.top - 40 || l.y < p.bottom + 40);
      if (repeated(key) || PAGE_NUMBER.test(l.text) || margin) {
        if (!bannerSeen.has(key.replace(/@\d+$/, ''))) { bannerSeen.add(key.replace(/@\d+$/, '')); banners.push({ text: l.cells.map(c => c.text).filter(t => !PAGE_NUMBER.test(t)).join(' | '), page: p.page }); }
        continue;
      }
      lines.push({ ...l, page: p.page });
    }
  }
  const sizes = lines.flatMap(l => l.cells.map(c => c.size)).sort((a, b) => a - b);
  const body = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 9;
  const left = lines.length ? Math.min(...lines.map(l => l.cells[0].x)) : 0;
  const isHeading = l => l.cells.length === 1 && l.cells[0].bold && l.cells[0].size >= body + 0.8;

  const sections = [];
  let section = null, table = null, kv = null, para = null, prev = null, title = extraction.metadata?.title ?? null, group = null, lastHeading = null;
  const open = (heading, page) => { section = { heading, group: null, page, kv: [], tables: [], paragraphs: [] }; sections.push(section); table = null; kv = null; para = null; group = null; };
  open(null, lines[0]?.page ?? 1);
  for (const l of lines) {
    const gap = prev && prev.page === l.page ? prev.y - l.y : Infinity;
    const [first] = l.cells;
    // Headings (a title wrapped over two lines is one heading).
    if (isHeading(l)) {
      // A heading wrapped over two lines (a badge beside it may sit between them) stays one heading.
      const headingGap = lastHeading && lastHeading.page === l.page ? lastHeading.y - l.y : Infinity;
      if (headingGap < first.size * 1.6 && section.heading && section.kv.every(k => k.badge) && !section.paragraphs.length && !section.tables.length) section.heading = `${section.heading} ${first.text}`;
      else open(first.text, l.page);
      lastHeading = l; prev = l; continue;
    }
    // A table header: two or more cells, all bold, in body size.
    if (l.cells.length >= 2 && l.cells.every(c => c.bold) && !(table && table.rows.length === 0 && gap < first.size * 1.6)) {
      table = { page: l.page, columns: l.cells.map(c => ({ name: c.text, x: c.x })), rows: [], group };
      section.tables.push(table); kv = null; para = null; prev = l; continue;
    }
    if (table) {
      // Header wrapped over two lines: join to the header names.
      if (table.rows.length === 0 && l.cells.every(c => c.bold) && gap < first.size * 1.6) {
        for (const c of l.cells) { const col = columnOf(table, c.x); if (col >= 0) table.columns[col].name += ` ${c.text}`; }
        prev = l; continue;
      }
      // A row: every cell starts at a column. A single long cell running across the columns is a paragraph.
      const spansColumns = l.cells.length === 1 && table.columns.length > 1 && first.x <= table.columns[0].x + 6 && first.w > (table.columns[1].x - table.columns[0].x) * 1.6 && first.x + first.w > table.columns[1].x + 20;
      const aligned = !spansColumns && l.cells.every(c => columnOf(table, c.x) >= 0) && first.x >= table.columns[0].x - 2;
      if (aligned && (gap < first.size * 3.2 || (prev && prev.page !== l.page))) {
        const cells = {};
        for (const c of l.cells) { const name = table.columns[columnOf(table, c.x)].name; cells[name] = cells[name] ? `${cells[name]} ${c.text}` : c.text; }
        const firstCol = columnOf(table, first.x) === 0;
        const last = table.rows.at(-1);
        // A wrapped cell continues the row above: a line closer than a row's spacing, or starting past the first column.
        const wrapped = last && (!firstCol ? gap < first.size * 1.6 : gap < first.size * 1.4 && l.cells.length === 1 && Object.keys(last.cells).length > 1);
        if (wrapped) {
          // A wrapped cell: continues the row above.
          for (const [name, text] of Object.entries(cells)) last.cells[name] = last.cells[name] ? `${last.cells[name]} ${text}` : text;
          last.text += ` ${l.text}`;
        } else table.rows.push({ cells, page: l.page, text: l.text });
        prev = l; continue;
      }
      table = null;
    }
    // A bold label and its value.
    const valueCells = l.cells.slice(1);
    if (first.bold && first.x <= left + 20 && valueCells.length && !valueCells[0].bold) {
      // Only the value column: a far-away cell on the same baseline (an image caption) is not part of it.
      const value = [valueCells[0]];
      for (const c of valueCells.slice(1)) if (c.x - (value.at(-1).x + value.at(-1).w) < 40) value.push(c);
      const text = value.map(c => c.text).join(' ');
      if (/^\(\d+ propert(y|ies)\)$/i.test(text)) { group = first.text; section.group ??= null; kv = null; prev = l; continue; }
      kv = { label: first.text, value: text, page: l.page, text: `${first.text}: ${text}`, valueX: value[0].x, group };
      section.kv.push(kv); para = null; prev = l; continue;
    }
    // A badge such as "CONDITION: FAIR (3/5)".
    if (l.cells.length === 1 && first.bold && /^[A-Z][A-Z /&-]{1,28}:\s*\S/.test(first.text)) {
      const [label, ...rest] = first.text.split(':');
      section.kv.push({ label: label.trim(), value: rest.join(':').trim(), page: l.page, text: first.text, badge: true, group });
      prev = l; continue;
    }
    // A label alone, then its value on the next line; or a wrapped label / value.
    if (kv && gap < first.size * 1.8 && l.cells.length === 1) {
      if (first.bold && first.x <= left + 20) { kv.label = `${kv.label} ${first.text}`; kv.text = `${kv.label}: ${kv.value}`; prev = l; continue; }
      // A wrapped value lines up with the value (or, in a callout, with the label); a caption elsewhere does not.
      if (!first.bold && (kv.valueX === undefined || Math.abs(first.x - kv.valueX) <= 6 || first.x <= left + 20)) {
        kv.value = kv.value ? `${kv.value} ${first.text}` : first.text; kv.valueX ??= first.x; kv.text = `${kv.label}: ${kv.value}`; prev = l; continue;
      }
    }
    if (l.cells.length === 1 && first.bold && first.x <= left + 20 && !kv) {
      kv = { label: first.text, value: '', page: l.page, text: first.text, group };
      section.kv.push(kv); prev = l; continue;
    }
    // Paragraph text: lines close together are one paragraph.
    kv = null;
    const text = l.cells.map(c => c.text).join(' ');
    if (para && gap < first.size * 1.7 && para.page === l.page) { para.text = joinWrapped(para.text, text); para.lines.push(text); } else {
      para = { text, page: l.page, lines: [text] };
      section.paragraphs.push(para);
    }
    prev = l;
  }
  // Labels with no value at all (a stray bold word) are dropped; sections with nothing in them too.
  for (const s of sections) s.kv = s.kv.filter(k => k.value || k.badge);
  title ??= sections.find(s => s.heading)?.heading ?? null;
  return { title, banners, sections: sections.filter(s => s.heading || s.kv.length || s.tables.length || s.paragraphs.length) };
}

function columnOf(table, x) {
  let best = -1;
  table.columns.forEach((c, i) => { if (x >= c.x - 6) best = i; });
  return best;
}
const joinWrapped = (a, b) => (/-$/.test(a) && /^[a-z]/.test(b) ? `${a.slice(0, -1)}${b}` : `${a} ${b}`);

/** Sentences of a paragraph, for quoting the one that says something. */
export const sentences = text => String(text ?? '').split(/(?<=[.!?])\s+(?=[A-Z(])/).map(s => s.trim()).filter(Boolean);
