/**
 * Controlled PDFs for the document-intelligence tests: real PDF files (standard Helvetica fonts, a text
 * layer, optional image-only pages for "scanned" pages), laid out like the Seagirt asset sheets and
 * inspection reports, so every expected value is known.
 */

/** A PDF from pages of positioned text: {items: [{x, y, text, bold, size}], image: true} (an image-only page). */
export function makePdf(pages, { title = null } = {}) {
  const objects = [];
  const add = body => { objects.push(body); return objects.length; };
  const catalog = add(null);
  const pagesObj = add(null);
  const regular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const info = add(`<< /Producer (pdfFixtures) ${title ? `/Title (${pdfText(title)})` : ''} /CreationDate (D:20260101000000Z) >>`);
  const kids = [];
  for (const page of pages) {
    const ops = [];
    let image = null;
    if (page.image) {
      image = add({ stream: Buffer.from([0x80]), dict: '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8' });
      ops.push('q 400 0 0 600 100 100 cm /Im1 Do Q');
    }
    for (const it of page.items ?? []) ops.push(`BT /${it.bold ? 'F2' : 'F1'} ${it.size ?? 9} Tf 1 0 0 1 ${it.x} ${it.y} Tm (${pdfText(it.text)}) Tj ET`);
    const content = add({ stream: Buffer.from(ops.join('\n'), 'latin1'), dict: '' });
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Contents ${content} 0 R /Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >>${image ? ` /XObject << /Im1 ${image} 0 R >>` : ''} >> >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const parts = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = [];
  let size = parts[0].length;
  objects.forEach((o, i) => {
    offsets.push(size);
    const body = typeof o === 'string' ? Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1')
      : Buffer.concat([Buffer.from(`${i + 1} 0 obj\n<< ${o.dict} /Length ${o.stream.length} >>\nstream\n`, 'latin1'), o.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    parts.push(body);
    size += body.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${size}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return new Uint8Array(Buffer.concat(parts));
}
const pdfText = s => String(s).replace(/[\\()]/g, ch => `\\${ch}`);

// ---- a document builder: headings, label/value rows, tables, paragraphs, on as many pages as needed ----

export function documentPdf(blocks, { title = null, banner = 'FIXTURE DOCUMENT. Test data only.', footer = 'FIX-DOC' } = {}) {
  const pages = [];
  let page = null, y = 0;
  const newPage = () => {
    page = { items: [] };
    pages.push(page);
    page.items.push({ x: 60, y: 806, text: banner, size: 7 });
    y = 770;
  };
  const need = h => { if (!page || y - h < 60) newPage(); };
  newPage();
  for (const b of blocks) {
    if (b.pageBreak) { newPage(); continue; }
    if (b.heading) { need(40); y -= 6; page.items.push({ x: 45, y, text: b.heading, bold: true, size: b.size ?? 12 }); y -= 18; continue; }
    if (b.badge) { page.items.push({ x: 430, y: y + 22, text: b.badge, bold: true, size: 8 }); continue; }
    if (b.kv) { for (const [label, value] of b.kv) { need(16); page.items.push({ x: 48, y, text: label, bold: true, size: 8 }, { x: 133, y, text: value, size: 9 }); y -= 16; } continue; }
    if (b.table) {
      const xs = b.xs ?? b.table[0].map((_, i) => 48 + i * Math.floor(480 / b.table[0].length));
      need(32);
      b.table[0].forEach((h, i) => page.items.push({ x: xs[i], y, text: h, bold: true, size: 8 }));
      y -= 16;
      for (const row of b.table.slice(1)) {
        need(16);
        row.forEach((cell, i) => {
          const parts = Array.isArray(cell) ? cell : [cell];
          parts.forEach((p, k) => { if (p) page.items.push({ x: xs[i], y: y - k * 11, text: p, size: 9, bold: b.boldCols?.includes(i) }); });
        });
        y -= 16 + 11 * (Math.max(...row.map(c => (Array.isArray(c) ? c.length : 1))) - 1);
      }
      y -= 6;
      continue;
    }
    if (b.para) { for (const line of [].concat(b.para)) { need(12); page.items.push({ x: 45, y, text: line, size: 9 }); y -= 11; } y -= 8; continue; }
  }
  pages.forEach((p, i) => p.items.push({ x: 45, y: 26, text: footer, size: 7 }, { x: 510, y: 26, text: `Page ${i + 1} of ${pages.length}`, size: 7 }));
  if (blocks.some(b => b.scanPage)) pages.push({ image: true, items: [] });
  return makePdf(pages, { title });
}

/** An asset sheet: identity, then property rows. */
export function specSheet({ assetId, globalId = 'GID-1', fields = [], title = `${assetId} asset sheet`, extraBlocks = [] }) {
  return documentPdf([
    { heading: assetId, size: 16 },
    { kv: [['Asset ID (Tag)', assetId], ['IFC GlobalId', globalId], ['Asset type', 'Transformer']] },
    { heading: 'Properties' },
    { kv: fields },
    ...extraBlocks,
  ], { title, banner: 'FIXTURE ASSET SHEET. Illustrative mock network. Not as-built.', footer: `${assetId} sheet` });
}

/** An inspection report: header rows, summary, visual table, measurements, actions, sign-off. */
export function inspectionReport({ assetId, globalId = 'GID-1', date = null, number = 'INS-1', type = 'Annual condition inspection', condition = null, conditions = 'Dry, 15 deg C',
  rating = null, summary = [], findings = [], measures = null, actions = [], scanPage = false, statedAssetId = assetId, nextDue = null, interval = null }) {
  const kv = [['Report number', number], ...(date ? [['Inspection date', date]] : []), ['Inspection type', type], ['Asset ID', statedAssetId], ['IFC GlobalId', globalId],
    ...(rating ? [['Rating', rating]] : []), ['Conditions', conditions], ['Inspector', 'Inspector T (fixture)']];
  return documentPdf([
    { heading: 'Transformer condition inspection report', size: 18 },
    ...(condition ? [{ badge: `CONDITION: ${condition}` }] : []),
    { kv },
    ...(summary.length ? [{ heading: 'Summary' }, { para: summary }] : []),
    ...(findings.length ? [{ heading: 'Visual inspection' }, { table: [['Item', 'Result', 'Notes'], ...findings], xs: [48, 184, 241], boldCols: [1] }] : []),
    ...(measures ? [{ heading: 'Insulating oil quality' }, { table: measures, xs: [48, 275, 360] }] : []),
    ...(actions.length ? [{ heading: 'Actions' }, { table: [['Action', 'Priority', 'Due'], ...actions], xs: [48, 411, 474] }] : []),
    { heading: 'Sign-off' },
    { kv: [...(condition ? [['Overall condition', condition.replace(/\((\d)\/(\d)\)/, '($1 of $2)')]] : []), ['Report status', 'Final (fixture)'], ...(nextDue ? [['Next inspection due', nextDue]] : []), ...(interval ? [['Inspection interval', interval]] : [])] },
    ...(scanPage ? [{ scanPage: true }] : []),
  ], { title: `${number} ${assetId} inspection report`, footer: number });
}
