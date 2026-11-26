/**
 * The PDF report, drawn with PDFKit from the report snapshot (snapshot.mjs): a real, printable document on a
 * white page — header, executive summary, criteria, asset summary table, a location plot, per-asset details,
 * source references and limitations, with page numbers. Nothing in it is computed again: every number and
 * finding comes from the snapshot, so it agrees with the register and the email.
 *
 * The location plot is drawn from the model's own coordinates (vector, no imagery, so no imagery licence is
 * involved); illustrative positions are said to be illustrative.
 */
import PDFDocument from 'pdfkit';

const NAVY = '#12305a', TEXT = '#1f2937', MUTED = '#5b6575', LINE = '#d5dce6', SOFT = '#f3f6fa';
const TONE = { INSPECTION_REQUIRED: '#b42318', REVIEW_RECOMMENDED: '#b54708', INSUFFICIENT_EVIDENCE: '#475467', NO_REQUIREMENT_IDENTIFIED: '#067647' };
const COND = c => (!c ? MUTED : /poor|bad|critical|unsatisf/i.test(c) ? '#b42318' : /fair|marginal/i.test(c) ? '#b54708' : /good|satisf/i.test(c) ? '#067647' : TEXT);
const M = 46;

/** The standard PDF fonts cover Windows-1252 only: other characters are spelled out. */
export function pdfText(value) {
  return String(value ?? '').replace(/[→⟶]/g, '->').replace(/[←]/g, '<-').replace(/≤/g, '<=').replace(/≥/g, '>=').replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/[≈]/g, '~').replace(/[δ]/g, 'delta').replace(/[ ]/g, ' ').replace(/[^\x09\x0a\x0d\x20-\x7e¡-ÿ–—•…€]/g, '?');
}
const refs = list => (list?.length ? ` [${list.join(', ')}]` : '');

/** Render the report; resolves to the PDF bytes. */
export function renderReportPdf(snap, { now = Date.now() } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: M, bottom: M + 14, left: M, right: M }, bufferPages: true,
      info: { Title: pdfText(snap.names.reportTitle), Author: 'Seagirt IFC Spatial Twin', Subject: pdfText(`${snap.project.name ?? ''} · ${snap.request.question}`), Keywords: `report ${snap.reportId}`, CreationDate: new Date(now) } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try { draw(doc, snap); doc.end(); } catch (error) { reject(error); }
  });
}

function draw(doc, snap) {
  const W = doc.page.width - 2 * M;
  const t = s => pdfText(s);
  const ensure = h => { if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage(); };
  const heading = (text, { size = 13, gap = 6 } = {}) => { ensure(size + 40); doc.moveDown(0.6); doc.font('Helvetica-Bold').fontSize(size).fillColor(NAVY).text(t(text), M, doc.y); doc.moveDown(0.15);
    doc.moveTo(M, doc.y).lineTo(M + W, doc.y).lineWidth(0.6).strokeColor(LINE).stroke(); doc.y += gap; };
  const para = (text, { size = 9, color = TEXT, font = 'Helvetica', gap = 0.3 } = {}) => { doc.font(font).fontSize(size).fillColor(color).text(t(text), M, doc.y, { width: W }); doc.moveDown(gap); };
  const bullet = (text, { size = 9, color = TEXT, indent = 10 } = {}) => { ensure(14); const y = doc.y; doc.font('Helvetica').fontSize(size).fillColor(NAVY).text('•', M + 2, y); doc.fillColor(color).text(t(text), M + indent + 2, y, { width: W - indent - 2 }); doc.moveDown(0.15); };
  const typeWord = snap.request.phrase;
  const inspection = snap.kind === 'INSPECTION';

  // ---- header ----
  doc.rect(0, 0, doc.page.width, 92).fill(NAVY);
  doc.font('Helvetica').fontSize(9).fillColor('#c9d6ea').text(t(`${snap.project.name ?? 'Project'}  ·  Electrical Digital Twin`), M, 24, { width: W });
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#ffffff').text(t(snap.names.reportTitle), M, 38, { width: W });
  doc.font('Helvetica').fontSize(8.5).fillColor('#c9d6ea')
    .text(t(`Generated ${snap.generatedAt.replace('T', ' ').slice(0, 16)} UTC  ·  IFC model ${snap.model.fileName ?? '—'}${snap.model.versionNumber ? ` v${snap.model.versionNumber}` : ''}  ·  Reference ${snap.reportId}${snap.revision > 1 ? ` rev ${snap.revision}` : ''}`), M, 66, { width: W });
  doc.y = 108;
  if (snap.illustrative) {
    const h = 30;
    doc.rect(M, doc.y, W, h).fillAndStroke('#fff4e5', '#f0b45a');
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#8a4b00').text('ILLUSTRATIVE REPORT', M + 10, doc.y + 6, { continued: true })
      .font('Helvetica').text(t('  —  generated from illustrative demonstration records, not actual inspection records. Not an engineering inspection or maintenance instruction.'), { width: W - 20 });
    doc.y += 8;
  }
  para(`Request: "${snap.request.question}"`, { size: 8.5, color: MUTED });

  // ---- executive summary ----
  heading('Executive summary');
  const s = snap.summary, cov = snap.inventoryCoverage;
  const kpis = inspection
    ? [[cov.inScope, `${cap(typeWord)} evaluated`, NAVY], [s.inspectionRequired, 'Inspection required', TONE.INSPECTION_REQUIRED], [s.reviewRecommended, 'Recommended for review', TONE.REVIEW_RECOMMENDED], [s.insufficientEvidence, 'Insufficient evidence', TONE.INSUFFICIENT_EVIDENCE]]
    : [[cov.evaluated, `${cap(typeWord)} in the model`, NAVY], [s.included, 'Included in this report', TONE.INSPECTION_REQUIRED], [cov.withInspectionRecords, 'With inspection records', NAVY], [cov.insufficientEvidence, 'Without inspection records', TONE.INSUFFICIENT_EVIDENCE]];
  const kw = (W - 3 * 8) / 4, ky = doc.y;
  kpis.forEach(([v, l, c], i) => {
    const x = M + i * (kw + 8);
    doc.rect(x, ky, kw, 46).fillAndStroke(SOFT, LINE);
    doc.font('Helvetica-Bold').fontSize(18).fillColor(c).text(String(v), x + 9, ky + 7, { width: kw - 18 });
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(t(l), x + 9, ky + 30, { width: kw - 18 });
  });
  doc.y = ky + 56;
  if (inspection) {
    para(s.inspectionRequired
      ? `${s.inspectionRequired} of ${cov.inScope} ${typeWord} require inspection on the evidence in their records. ${s.reviewRecommended ? `${s.reviewRecommended} more are candidates for engineering review: they meet a review criterion but no documented requirement or configured policy makes an inspection required.` : ''}`
      : `No ${typeWord} meet the inspection-required criteria on the available records. ${s.reviewRecommended ? `${s.reviewRecommended} are candidates for engineering review.` : ''}`);
    if (s.mainReasons.length) { para('Main reasons for inspection:', { font: 'Helvetica-Bold', size: 9 }); for (const r of s.mainReasons) bullet(`${r.text} — ${r.assets} asset${r.assets === 1 ? '' : 's'}`); }
  } else para(`${s.included} ${typeWord} are included: ${snap.appliedCriteria[0]?.text ?? ''}`);
  para(`Coverage: ${cov.evaluated} assets evaluated; documents linked for ${cov.withDocuments}; inspection records available for ${cov.withInspectionRecords}${cov.failed.length ? `; ${cov.failed.length} could not be assessed` : ''}.`, { color: MUTED, size: 8.5 });

  // ---- criteria ----
  heading(inspection ? 'Inspection criteria' : 'Selection');
  table(doc, [{ h: 'Rule', w: 0.56 }, { h: 'Source', w: 0.16 }, { h: 'Effect', w: 0.18 }, { h: 'Assets', w: 0.1 }],
    snap.appliedCriteria.map(c => [c.text, SOURCE_LABEL[c.source] ?? c.source, EFFECT[c.effect] ?? c.effect, String(c.assets)]), { W });
  para('Sources: Documented = stated in the ACC inspection records; Policy = a configured inspection policy; User assumption = set by the request; Derived = a review criterion computed from the records; Operational = the twin\'s operational status.', { size: 7.5, color: MUTED });

  // ---- asset summary ----
  heading(inspection ? 'Assets requiring inspection or review' : 'Assets included');
  if (!snap.assets.length) para(`No ${typeWord} meet the criteria.`, { color: MUTED });
  else {
    const rows = snap.assets.map(a => [a.id, a.location.zone ?? (Number.isFinite(a.location.lat) ? `${a.location.lat.toFixed(5)}, ${a.location.lon.toFixed(5)}` : 'Not positioned'),
      a.operationalStatus?.label ?? '—', a.latestInspection?.date ?? 'None', a.condition ? `${a.condition.label ?? ''}${Number.isFinite(a.condition.score) ? ` ${a.condition.score}/${a.condition.scale}` : ''}` : '—',
      ...(inspection ? [a.inspection.label, a.inspection.priority.level ?? '—'] : []), a.inspection.followUps[0]?.text ?? (inspection ? '—' : (a.keyFindings[0]?.title ?? '—'))]);
    table(doc, inspection
      ? [{ h: 'Asset', w: 0.09 }, { h: 'Location', w: 0.14 }, { h: 'Status', w: 0.1 }, { h: 'Latest inspection', w: 0.11 }, { h: 'Condition', w: 0.09 }, { h: 'Requirement', w: 0.13 }, { h: 'Priority', w: 0.08 }, { h: 'Recommended follow-up', w: 0.26 }]
      : [{ h: 'Asset', w: 0.1 }, { h: 'Location', w: 0.17 }, { h: 'Status', w: 0.12 }, { h: 'Latest inspection', w: 0.13 }, { h: 'Condition', w: 0.12 }, { h: 'Note', w: 0.36 }], rows,
      { W, color: (row, i) => (i === 4 ? COND(row[4]) : inspection && i === 5 ? TONE[snap.assets[rows.indexOf(row)].inspection.classification] : null) });
  }

  // ---- location plot ----
  // The plot moves to the next page with its heading, never without it.
  if (snap.assets.some(a => Number.isFinite(a.location.lon)) && doc.y + 340 > doc.page.height - doc.page.margins.bottom) doc.addPage();
  heading('Asset locations');
  locationPlot(doc, snap, W);

  // ---- per asset ----
  for (const a of snap.assets) {
    heading(`${a.id}${a.description ? ` — ${a.description}` : ''}`, { size: 11.5 });
    const meta = [`Type: ${a.typeLabel}`, a.globalId ? `IFC GlobalId: ${a.globalId}` : null, `Status: ${a.operationalStatus?.label ?? 'not reported'}${a.operationalStatus?.asOf ? ` (as of ${a.operationalStatus.asOf})` : ''}`, `Position: ${a.location.basis}`].filter(Boolean).join('   ·   ');
    para(meta, { size: 8, color: MUTED });
    if (inspection) {
      ensure(30);
      const c = TONE[a.inspection.classification];
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(c).text(t(`${a.inspection.label}${a.inspection.priority.level ? ` · Priority ${a.inspection.priority.level}` : ''}`), M, doc.y);
      para(`Priority basis: ${a.inspection.priority.basis}  ·  Next inspection: ${a.inspection.nextInspection.date ?? 'unknown'} (${a.inspection.nextInspection.basis.toLowerCase()})${refs(a.inspection.nextInspection.refs)}`, { size: 8, color: MUTED });
      para('Why:', { font: 'Helvetica-Bold', size: 8.5, gap: 0.1 });
      const order = [a.inspection.classification, 'INSPECTION_REQUIRED', 'REVIEW_RECOMMENDED', 'INSUFFICIENT_EVIDENCE'];
      for (const r of [...a.inspection.reasons].sort((x, y) => order.indexOf(x.classification) - order.indexOf(y.classification))) bullet(`${r.text}${refs(r.refs)}  (${SOURCE_LABEL[r.source] ?? r.source}${r.classification !== a.inspection.classification ? `, ${EFFECT[r.classification].toLowerCase()}` : ''})`, { size: 8.5 });
    }
    if (a.condition) para(`Latest documented condition: ${a.condition.label ?? ''}${Number.isFinite(a.condition.score) ? ` (${a.condition.score}/${a.condition.scale})` : ''} on ${a.condition.date}${refs(a.condition.refs)}${a.conditionTrend.length > 1 ? `  ·  Trend: ${a.conditionTrend.map(p => `${p.date.slice(0, 4)} ${p.score}/${p.scale}`).join(' -> ')}` : ''}`, { size: 8.5 });
    if (a.inspections.length) {
      para('Inspection history:', { font: 'Helvetica-Bold', size: 8.5, gap: 0.1 });
      table(doc, [{ h: 'Date', w: 0.12 }, { h: 'Condition', w: 0.12 }, { h: 'Findings', w: 0.5 }, { h: 'Actions raised', w: 0.26 }],
        a.inspections.map(h => [`${h.date ?? 'Undated'}${h.ref ? ` [${h.ref}]` : ''}`, h.condition ?? '—', truncate(h.findings ?? '—', 300), truncate(h.actions ?? '—', 200)]), { W, size: 7.5, color: (row, i) => (i === 1 ? COND(row[1]) : null) });
    } else para('No inspection records are available for this asset.', { size: 8.5, color: MUTED });
    if (a.keyFindings.length) { para('Significant findings:', { font: 'Helvetica-Bold', size: 8.5, gap: 0.1 }); for (const k of a.keyFindings) bullet(`${k.title}: ${k.text}${refs(k.refs)}`, { size: 8.5 }); }
    const open = a.actions.filter(x => x.closure !== 'COMPLETED_WITH_EVIDENCE');
    if (open.length) {
      para(`Outstanding actions (${open.length}):`, { font: 'Helvetica-Bold', size: 8.5, gap: 0.1 });
      for (const x of open.slice(0, 8)) bullet(`${x.action} — raised ${x.raisedOn}${x.priority ? `, ${x.priority}` : ''}: ${x.closure === 'NOT_COMPLETED_WITH_EVIDENCE' ? 'documented as not completed' : 'no record of completion'}`, { size: 8.5 });
      if (open.length > 8) para(`${open.length - 8} more in the Excel register.`, { size: 8, color: MUTED });
    }
    if (a.inspection.followUps.length) { para('Recommended follow-up (for review):', { font: 'Helvetica-Bold', size: 8.5, gap: 0.1 }); for (const f of a.inspection.followUps) bullet(`${f.text}${f.due ? ` (due ${f.due})` : ''}${refs(f.refs)}  (${f.basis === 'DOCUMENTED' ? 'documented' : 'suggested'})`, { size: 8.5 }); }
    if (a.specifications) {
      para('Technical specifications:', { font: 'Helvetica-Bold', size: 8.5, gap: 0.1 });
      table(doc, [{ h: 'Specification', w: 0.4 }, { h: 'Value', w: 0.6 }], a.specifications.documented.map(x => [x.label, `${x.value}${x.value !== x.asWritten ? ` (as written: ${x.asWritten})` : ''}${x.ref ? ` [${x.ref}]` : ''}`]), { W, size: 7.5 });
      if (a.specifications.missing.length) para(`Not documented: ${a.specifications.missing.join(', ')}.`, { size: 8, color: MUTED });
    }
    for (const l of a.inspection.limitations) para(`Limitation: ${l}`, { size: 8, color: MUTED });
  }

  // ---- other evaluated assets ----
  const others = snap.evaluated.filter(e => e.inScope && !snap.assets.some(a => a.id === e.id));
  if (inspection && others.length) {
    heading('Other evaluated assets');
    table(doc, [{ h: 'Asset', w: 0.14 }, { h: 'Classification', w: 0.26 }, { h: 'Latest inspection', w: 0.18 }, { h: 'Note', w: 0.42 }],
      others.map(e => [e.id, e.label, e.latestInspection ?? 'None', e.analysisError ? `Documents could not be read: ${e.analysisError}` : !e.documents?.linked ? 'No ACC documents linked' : e.classification === 'INSUFFICIENT_EVIDENCE' ? 'No readable inspection report among the linked documents' : 'Inspection records reviewed; no rule applies']), { W, size: 7.5 });
  }

  // ---- sources ----
  heading('Source references');
  if (!snap.sources.length) para('No ACC documents were cited.', { color: MUTED });
  else table(doc, [{ h: '#', w: 0.05 }, { h: 'Document', w: 0.43 }, { h: 'Version', w: 0.08 }, { h: 'Pages', w: 0.1 }, { h: 'Asset', w: 0.1 }, { h: 'ACC link', w: 0.24 }],
    snap.sources.map(x => [String(x.n), `${x.title ?? x.fileName}\n${x.fileName ?? ''}`, x.version ? `V${x.version}` : '—', x.pages.length ? x.pages.join(', ') : '—', x.assetId, x.webViewUrl ? 'Open in ACC' : 'Not available']),
    { W, size: 7.5, links: (row, i) => (i === 5 ? snap.sources[Number(row[0]) - 1]?.webViewUrl ?? null : null) });
  para(`Model: ${snap.model.fileName ?? '—'}${snap.model.versionNumber ? ` v${snap.model.versionNumber}` : ''}. ACC document versions as read when the report was generated; the report stays tied to them if the documents change.`, { size: 7.5, color: MUTED });

  // ---- limitations ----
  heading('Limitations');
  for (const l of snap.limitations) bullet(l, { size: 8.5 });

  // ---- page numbers ----
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const y = doc.page.height - M + 8;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
      .text(t(`${snap.names.reportTitle} · ${snap.reportId}${snap.illustrative ? ' · ILLUSTRATIVE' : ''}`), M, y, { width: W / 2, lineBreak: false })
      .text(`Page ${i + 1} of ${range.count}`, M + W / 2, y, { width: W / 2, align: 'right', lineBreak: false });
  }
}

const SOURCE_LABEL = { DOCUMENTED: 'Documented', POLICY: 'Policy', USER_ASSUMPTION: 'User assumption', DERIVED: 'Derived', OPERATIONAL: 'Operational', USER_REQUEST: 'Request' };
const EFFECT = { INSPECTION_REQUIRED: 'Inspection required', REVIEW_RECOMMENDED: 'Review recommended', INSUFFICIENT_EVIDENCE: 'Insufficient evidence', NO_REQUIREMENT_IDENTIFIED: 'No requirement', INCLUDED: 'Included' };
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A compact table: header row repeated on each page, wrapped cells, alternate shading. */
function table(doc, cols, rows, { W, size = 8, color = () => null, links = () => null } = {}) {
  const pad = 3.5;
  const widths = cols.map(c => c.w * W);
  const rowHeight = (cells, font) => Math.max(...cells.map((c, i) => doc.font(font).fontSize(size).heightOfString(pdfText(c), { width: widths[i] - 2 * pad }))) + 2 * pad;
  const header = () => {
    const h = rowHeight(cols.map(c => c.h), 'Helvetica-Bold');
    const y = doc.y;
    doc.rect(M, y, W, h).fill('#e8eef6');
    let x = M;
    cols.forEach((c, i) => { doc.font('Helvetica-Bold').fontSize(size).fillColor(NAVY).text(pdfText(c.h), x + pad, y + pad, { width: widths[i] - 2 * pad }); x += widths[i]; });
    doc.y = y + h;
  };
  // The header never ends a page alone: it starts where its first row fits too.
  const first = rows.length ? rowHeight(rows[0], 'Helvetica') : 0;
  if (doc.y + rowHeight(cols.map(c => c.h), 'Helvetica-Bold') + first > doc.page.height - doc.page.margins.bottom) doc.addPage();
  header();
  rows.forEach((row, r) => {
    const h = rowHeight(row, 'Helvetica');
    if (doc.y + h > doc.page.height - doc.page.margins.bottom) { doc.addPage(); header(); }
    const y = doc.y;
    if (r % 2) doc.rect(M, y, W, h).fill('#fafbfd');
    let x = M;
    row.forEach((cell, i) => {
      const link = links(row, i);
      doc.font('Helvetica').fontSize(size).fillColor(link ? '#1d4ed8' : color(row, i) ?? TEXT).text(pdfText(cell), x + pad, y + pad, { width: widths[i] - 2 * pad, ...(link ? { link, underline: true } : {}) });
      x += widths[i];
    });
    doc.moveTo(M, y + h).lineTo(M + W, y + h).lineWidth(0.4).strokeColor(LINE).stroke();
    doc.y = y + h;
  });
  doc.x = M;
  doc.moveDown(0.4);
}

/** The included assets at their model coordinates, with the rest of the inventory faint for context. */
function locationPlot(doc, snap, W) {
  const included = snap.assets.filter(a => Number.isFinite(a.location.lon));
  if (!included.length) {
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(pdfText(snap.assets.length ? 'None of the included assets has a position in the model: no location plot is drawn.' : 'No assets to plot.'), M, doc.y, { width: W });
    doc.moveDown(0.5);
    return;
  }
  const H = 250;
  if (doc.y + H + 40 > doc.page.height - doc.page.margins.bottom) doc.addPage();
  const top = doc.y;
  const lat0 = included.reduce((s, a) => s + a.location.lat, 0) / included.length;
  const kx = Math.cos(lat0 * Math.PI / 180) * 111_320, ky = 110_574;
  const xs = included.map(a => a.location.lon * kx), ys = included.map(a => a.location.lat * ky);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  // Fit the included assets with a margin (at least 60 m across, so one asset is not drawn at a huge scale).
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const k = Math.min((W - 90) / Math.max(maxX - minX, 60), (H - 60) / Math.max(maxY - minY, 60));
  const px = x => M + W / 2 + (x - cx) * k, py = y => top + H / 2 - (y - cy) * k;
  doc.save();
  doc.rect(M, top, W, H).fillAndStroke('#f7f9fc', LINE);
  doc.rect(M, top, W, H).clip();
  for (const c of snap.context ?? []) {
    if (!Number.isFinite(c.lon)) continue;
    const x = px(c.lon * kx), y = py(c.lat * ky);
    if (x < M || x > M + W || y < top || y > top + H) continue;
    doc.circle(x, y, 1.6).fill('#c3ccd8');
  }
  const required = new Set(snap.selectedIds);
  for (const a of included) {
    const x = px(a.location.lon * kx), y = py(a.location.lat * ky);
    if (snap.kind === 'INSPECTION' && !required.has(a.id)) doc.circle(x, y, 5).lineWidth(1.6).strokeColor('#b54708').stroke();
    else doc.circle(x, y, 5).fill(NAVY);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(TEXT).text(pdfText(a.id), x + 7, y - 4, { lineBreak: false });
  }
  doc.restore();
  // Legend, north arrow and scale.
  const ly = top + H - 16;
  doc.circle(M + 12, ly, 4).fill(NAVY);
  doc.font('Helvetica').fontSize(7.5).fillColor(TEXT).text(snap.kind === 'INSPECTION' ? 'Inspection required' : 'Included asset', M + 20, ly - 4, { lineBreak: false });
  let lx = M + 110;
  if (snap.kind === 'INSPECTION' && snap.reviewIds.length) { doc.circle(lx, ly, 4).lineWidth(1.4).strokeColor('#b54708').stroke(); doc.fillColor(TEXT).text('Review recommended', lx + 8, ly - 4, { lineBreak: false }); lx += 105; }
  doc.circle(lx, ly, 1.8).fill('#c3ccd8'); doc.fillColor(TEXT).text('Other modelled assets', lx + 6, ly - 4, { lineBreak: false });
  const nx = M + W - 20, ny = top + 14;
  doc.moveTo(nx, ny + 12).lineTo(nx, ny).lineWidth(1).strokeColor(TEXT).stroke();
  doc.polygon([nx - 3, ny + 4], [nx, ny - 1], [nx + 3, ny + 4]).fill(TEXT);
  doc.font('Helvetica-Bold').fontSize(7).text('N', nx - 2.5, ny + 14, { lineBreak: false });
  const metres = [10, 20, 50, 100, 200, 500, 1000, 2000].find(m => m * k > 50) ?? 2000;
  const bx = M + W - 20 - metres * k, by = top + H - 14;
  doc.moveTo(bx, by).lineTo(bx + metres * k, by).lineWidth(1.4).strokeColor(TEXT).stroke();
  doc.font('Helvetica').fontSize(7).fillColor(TEXT).text(`${metres >= 1000 ? `${metres / 1000} km` : `${metres} m`}`, bx, by - 10, { width: metres * k, align: 'center', lineBreak: false });
  doc.y = top + H + 6;
  doc.x = M;
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(pdfText(`Schematic plot of the assets' positions in the IFC model (WGS84), drawn without imagery.${snap.assets.some(a => /illustrative/i.test(a.location.basis)) ? ' Positions are illustrative model positions, not surveyed locations.' : ''}`), M, doc.y, { width: W });
  doc.moveDown(0.4);
}
