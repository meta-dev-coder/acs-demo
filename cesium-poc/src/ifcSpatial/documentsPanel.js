/**
 * Asset documentation on the IFC Spatial Twin screen: the index of PDFs in ACC Docs (server/
 * ifcSpatial/documents.mjs), the PDF preview, and the Asset Documentation management view.
 *
 *  - The index is read once per model (`/documents?file=…&auto=1`: the server re-reads ACC only when
 *    its index is missing or stale), and after a sync or a manual mapping; selecting an asset never
 *    goes to ACC.
 *  - Preview: the browser's own PDF viewer in an iframe on the server's content route (the PDF is
 *    streamed from ACC with the user's session; no token or storage URL reaches the page), with
 *    Download and Open in ACC (ACC's own web link for the item).
 *  - Management: totals, last sync and its errors, Sync from ACC, search, category and status
 *    filters, and assigning a document to an asset by hand (kept across syncs).
 */
const API = '/api/ifc-spatial';
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const fmtDate = iso => { if (!iso) return '—'; const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
const fmtSize = n => (Number.isFinite(n) ? (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`) : '');
export const STATUS_LABEL = Object.freeze({ matched: 'Matched', suggested: 'Suggested', ambiguous: 'Ambiguous', unmatched: 'Unmatched', reference: 'Reference', missing: 'Missing in ACC' });
const contentUrl = (doc, download = false) => `${API}/documents/${encodeURIComponent(doc.documentId)}/content${download ? '?download=1' : ''}`;

/** The documents linked to an asset (and, for a crane, to its steel), newest first in each category. */
export function documentsForAsset(index, assetId) {
  if (!index || !assetId) return [];
  const ids = new Set([assetId, `${assetId}-STRUCT`, String(assetId).replace(/-STRUCT$/, '')]);
  // The asset's own document ("TX-M2_Transformer.pdf") first, then its dated reports (inspections), newest first.
  const rank = d => (d.title || d.docDate ? 1 : 0);
  return index.documents.filter(d => d.mapping?.status === 'matched' && ids.has(d.mapping.assetId))
    .sort((a, b) => rank(a) - rank(b) || String(b.docDate ?? '').localeCompare(String(a.docDate ?? '')));
}

/** The document rows of an asset panel: name, category and version, Preview / Download / Open in ACC. */
export function documentListHtml(docs) {
  if (!docs.length) return '<p class="isp-muted isp-doc-none">No document linked to this asset.</p>';
  return `<ul class="isp-doc-list">${docs.map(d => `<li class="isp-doc${d.availability === 'missing' ? ' is-missing' : ''}">
      <span class="isp-doc-icon" aria-hidden="true">PDF</span>
      <span class="isp-doc-text"><b>${esc(d.fileName)}</b>${d.title || d.docDate ? `
        <small class="isp-doc-report">${esc([d.title, d.docDate].filter(Boolean).join(' · '))}</small>` : ''}
        <small>${esc(d.categoryLabel || 'Asset documentation')}${d.versionNumber ? ` · V${esc(d.versionNumber)}` : ''}${d.lastModifiedTime ? ` · ${esc(fmtDate(d.lastModifiedTime))}` : ''}${d.size ? ` · ${esc(fmtSize(d.size))}` : ''}</small>
        <small>Source: Autodesk Construction Cloud${d.availability === 'missing' ? ' · not found at the last sync' : ''}</small></span>
      ${d.availability === 'missing' ? '' : `<span class="isp-doc-actions">
        <button type="button" class="isp-btn" data-doc-preview="${esc(d.documentId)}">Preview</button>
        <a class="isp-btn" href="${esc(contentUrl(d, true))}" download="${esc(d.fileName)}">Download</a>
        ${d.webViewUrl ? `<a class="isp-btn" href="${esc(d.webViewUrl)}" target="_blank" rel="noopener noreferrer">Open in ACC</a>` : ''}</span>`}</li>`).join('')}</ul>`;
}

/**
 * @param {object} o
 * @param {HTMLElement} o.host
 * @param {Function} o.fileName      () => the model file the documents are linked against
 * @param {Function} o.onIndex       (index) => void, after every load
 * @param {Function} o.onSelectAsset (assetId) => void, from the management table
 */
export function createDocumentsPanel({ host, fileName, onIndex = () => {}, onSelectAsset = () => {}, fetchImpl = (...args) => fetch(...args) }) {
  const preview = document.createElement('div');
  preview.className = 'isp-docview-wrap';
  preview.hidden = true;
  const manager = document.createElement('section');
  manager.className = 'isp-docs isp-card';
  manager.setAttribute('aria-label', 'Asset documentation');
  manager.hidden = true;
  host.append(manager, preview);
  const st = { index: null, loading: false, error: null, search: '', category: '', status: '', assigning: null, file: null };

  async function call(path, { method = 'GET', body } = {}) {
    const response = await fetchImpl(`${API}${path}`, { method, credentials: 'same-origin', headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(json?.error?.message ?? `The server answered ${response.status}.`), { code: json?.error?.code ?? `HTTP_${response.status}` });
    return json;
  }

  /** Load the index for the current model (the server syncs first if its index is missing or stale). */
  async function load({ sync = false } = {}) {
    const file = fileName();
    if (!file) return null;
    st.loading = true; st.error = null; st.file = file;
    render();
    try {
      st.index = await call(sync ? `/documents/sync?file=${encodeURIComponent(file)}` : `/documents?file=${encodeURIComponent(file)}&auto=1`, { method: sync ? 'POST' : 'GET' });
      onIndex(st.index);
    } catch (error) {
      st.error = error;
    } finally {
      st.loading = false;
      render();
    }
    return st.index;
  }

  // ---- preview ----

  /** The preview; `page` opens it at a cited page (browsers' PDF viewers follow #page=N). */
  function openPreview(documentId, { page = null } = {}) {
    const doc = st.index?.documents.find(d => d.documentId === documentId);
    if (!doc) return false;
    preview.hidden = false;
    preview.innerHTML = `<div class="isp-docview isp-card" role="dialog" aria-modal="true" aria-label="${esc(doc.fileName)}">
      <div class="isp-docview-head"><span class="isp-doc-icon" aria-hidden="true">PDF</span>
        <div><b>${esc(doc.fileName)}</b><small>${esc(doc.categoryLabel || '')}${doc.versionNumber ? ` · V${esc(doc.versionNumber)}` : ''}${page ? ` · <span class="isp-docview-page">page ${esc(page)}</span>` : ''} · Autodesk Construction Cloud</small></div>
        <a class="isp-btn" href="${esc(contentUrl(doc, true))}" download="${esc(doc.fileName)}">Download</a>
        ${doc.webViewUrl ? `<a class="isp-btn" href="${esc(doc.webViewUrl)}" target="_blank" rel="noopener noreferrer">Open in ACC</a>` : ''}
        <button type="button" class="isp-x" data-doc-close aria-label="Close">×</button></div>
      <iframe class="isp-docview-frame" title="${esc(doc.fileName)}" src="${esc(`${contentUrl(doc)}${page ? `#page=${Number(page)}` : ''}`)}"></iframe>
      <p class="isp-muted isp-docview-fallback">No preview? Some browsers do not show PDFs inline: <a href="${esc(contentUrl(doc, true))}" download="${esc(doc.fileName)}">download it</a>.</p></div>`;
    preview.querySelector('[data-doc-close]').focus();
    return true;
  }
  /**
   * A generated file in the same dialog: a PDF inline (the browser's viewer), anything else as the HTML the
   * caller built (the register's rows). `html` is built by the caller from escaped parts.
   */
  function openArtifact({ title, subtitle = '', url, downloadUrl, filename, kind = 'PDF', html = null }) {
    preview.hidden = false;
    preview.innerHTML = `<div class="isp-docview isp-card" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="isp-docview-head"><span class="isp-doc-icon${kind === 'XLSX' ? ' is-xlsx' : ''}" aria-hidden="true">${kind === 'XLSX' ? 'XLS' : 'PDF'}</span>
        <div><b>${esc(title)}</b><small>${esc(subtitle)}</small></div>
        <a class="isp-btn" href="${esc(downloadUrl)}" download="${esc(filename)}">Download</a>
        <button type="button" class="isp-x" data-doc-close aria-label="Close">×</button></div>
      ${kind === 'PDF' ? `<iframe class="isp-docview-frame" title="${esc(title)}" src="${esc(url)}"></iframe>
      <p class="isp-muted isp-docview-fallback">No preview? Some browsers do not show PDFs inline: <a href="${esc(downloadUrl)}" download="${esc(filename)}">download it</a>.</p>` : html ?? ''}</div>`;
    preview.querySelector('[data-doc-close]').focus();
    return true;
  }
  const closePreview = () => { preview.hidden = true; preview.replaceChildren(); };

  // ---- management view ----

  function rows() {
    const q = st.search.trim().toLowerCase();
    return (st.index?.documents ?? []).filter(d => {
      const status = d.availability === 'missing' ? 'missing' : d.mapping.status;
      if (st.status && status !== st.status) return false;
      if (st.category && d.category !== st.category) return false;
      return !q || `${d.fileName} ${d.assetCode ?? ''} ${d.mapping.assetId ?? ''}`.toLowerCase().includes(q);
    });
  }

  function render() {
    if (manager.hidden) return;
    const idx = st.index;
    const s = idx?.summary;
    const categories = [...new Set((idx?.documents ?? []).map(d => d.category).filter(Boolean))].sort();
    const stat = (label, value, key) => `<button type="button" class="isp-docs-stat${st.status === key ? ' is-on' : ''}" ${key ? `data-docs-status="${key}"` : 'disabled'}><b>${value ?? '—'}</b><span>${label}</span></button>`;
    const assetOptions = (idx?.assets ?? []).map(a => `<option value="${esc(a.assetId)}">${esc(a.assetId)} · ${esc(a.name ?? a.ifcClass)}</option>`).join('');
    const row = d => {
      const status = d.availability === 'missing' ? 'missing' : d.mapping.status;
      const assign = st.assigning === d.documentId;
      return `<tr>
        <td>${d.mapping.assetId ? `<button type="button" class="isp-linkbtn" data-docs-asset="${esc(d.mapping.assetId)}">${esc(d.mapping.assetId)}</button>` : d.mapping.suggestion ? `<span class="isp-muted">${esc(d.mapping.suggestion)}?</span>` : '—'}</td>
        <td><button type="button" class="isp-linkbtn" data-doc-preview="${esc(d.documentId)}"${d.availability === 'missing' ? ' disabled' : ''}>${esc(d.fileName)}</button><small>${esc(d.categoryLabel || 'Reference')}${d.versionNumber ? ` · V${esc(d.versionNumber)}` : ''}</small></td>
        <td><span class="isp-docs-status is-${status}">${STATUS_LABEL[status]}${d.mapping.manual ? ' · manual' : ''}</span>${d.mapping.candidates?.length > 1 && status === 'ambiguous' ? `<small>${esc(d.mapping.candidates.join(', '))}</small>` : ''}</td>
        <td>${assign ? `<form class="isp-docs-assign" data-docs-form="${esc(d.documentId)}"><input name="asset" list="isp-docs-assets" placeholder="Asset id" value="${esc(d.mapping.assetId ?? d.mapping.suggestion ?? '')}" aria-label="Asset for ${esc(d.fileName)}">
            <button type="submit" class="isp-btn is-primary">Link</button><button type="button" class="isp-btn" data-docs-cancel>Cancel</button></form>`
          : `<button type="button" class="isp-btn" data-docs-assign="${esc(d.documentId)}">${d.mapping.assetId ? 'Change' : 'Assign'}</button>
             ${d.mapping.manual ? `<button type="button" class="isp-btn" data-docs-auto="${esc(d.documentId)}" title="Back to automatic matching">Auto</button>` : d.mapping.assetId ? `<button type="button" class="isp-btn" data-docs-unlink="${esc(d.documentId)}">Unlink</button>` : ''}`}</td></tr>`;
    };
    const list = rows();
    manager.innerHTML = `<div class="isp-docs-head"><div><h2>Asset Documentation</h2>
        <p class="isp-muted">${idx?.folder ? `ACC Docs · ${esc(idx.folder.path)}` : 'ACC Docs'} · last sync ${esc(fmtDate(idx?.lastSyncedAt))}${idx?.model?.versionNumber ? ` · linked to ${esc(idx.model.fileName)} v${esc(idx.model.versionNumber)}` : ''}</p></div>
        <button type="button" class="isp-btn is-primary" data-docs-sync${st.loading ? ' disabled' : ''}>${st.loading ? 'Syncing…' : 'Sync from ACC'}</button>
        <button type="button" class="isp-x" data-docs-close aria-label="Close">×</button></div>
      ${st.error ? `<p class="isp-err">${esc(st.error.message)} <small>(${esc(st.error.code)})</small></p>` : ''}
      ${idx?.lastError ? `<p class="isp-err">Last sync failed ${esc(fmtDate(idx.lastError.at))}: ${esc(idx.lastError.message)} <small>(${esc(idx.lastError.code)})</small></p>` : ''}
      ${idx?.model?.note ? `<p class="isp-note">${esc(idx.model.note)}</p>` : ''}
      <div class="isp-docs-stats">${stat('PDFs in ACC', s?.available, '')}${stat('Matched', s?.matched, 'matched')}${stat('Unmatched', s ? s.unmatched + s.suggested : null, 'unmatched')}${stat('Ambiguous', s?.ambiguous, 'ambiguous')}${stat('Missing in ACC', s?.missing, 'missing')}${stat('Assets without documents', s?.assetsWithoutDocuments, '')}</div>
      ${idx?.lastChanges ? `<p class="isp-muted isp-docs-changes">Last sync: ${idx.lastChanges.added} new, ${idx.lastChanges.updated} updated, ${idx.lastChanges.renamed} renamed, ${idx.lastChanges.missing} missing.</p>` : ''}
      <div class="isp-docs-filters"><input type="search" data-docs-search placeholder="Search documents or assets" value="${esc(st.search)}" aria-label="Search documents">
        <select data-docs-category aria-label="Category"><option value="">All categories</option>${categories.map(c => `<option value="${esc(c)}"${st.category === c ? ' selected' : ''}>${esc(c.replace(/^\d+_/, '').replace(/_/g, ' '))}</option>`).join('')}</select>
        <select data-docs-statusf aria-label="Status"><option value="">All statuses</option>${['matched', 'suggested', 'ambiguous', 'unmatched', 'reference', 'missing'].map(k => `<option value="${k}"${st.status === k ? ' selected' : ''}>${STATUS_LABEL[k]}</option>`).join('')}</select></div>
      <datalist id="isp-docs-assets">${assetOptions}</datalist>
      <div class="isp-docs-table-wrap"><table class="isp-docs-table"><thead><tr><th>Asset</th><th>Document</th><th>Status</th><th></th></tr></thead>
        <tbody>${list.map(row).join('') || `<tr><td colspan="4" class="isp-muted">${st.loading ? 'Reading ACC…' : idx ? 'No documents match.' : 'Not loaded yet.'}</td></tr>`}</tbody></table></div>
      ${s?.assetsWithoutDocuments ? `<details class="isp-docs-missing"><summary>Assets without documents · ${s.assetsWithoutDocuments}</summary><p>${idx.assetsWithoutDocuments.map(a => `<button type="button" class="isp-linkbtn" data-docs-asset="${esc(a)}">${esc(a)}</button>`).join(' ')}</p></details>` : ''}`;
  }

  async function setMapping(documentId, body) {
    try {
      st.index = await call(`/documents/${encodeURIComponent(documentId)}/mapping?file=${encodeURIComponent(fileName())}`, { method: 'PUT', body });
      st.assigning = null;
      onIndex(st.index);
    } catch (error) { st.error = error; }
    render();
  }

  function onClick(event) {
    const t = event.target.closest('button, a');
    if (!t) return;
    if (t.dataset.docPreview) { openPreview(t.dataset.docPreview); return; }
    if ('docClose' in t.dataset) { closePreview(); return; }
    if ('docsClose' in t.dataset) { manager.hidden = true; return; }
    if ('docsSync' in t.dataset) { void load({ sync: true }); return; }
    if (t.dataset.docsStatus !== undefined) { st.status = st.status === t.dataset.docsStatus ? '' : t.dataset.docsStatus; render(); return; }
    // Going to an asset closes this view, so its panel and the map are in sight.
    if (t.dataset.docsAsset) { manager.hidden = true; onSelectAsset(t.dataset.docsAsset); return; }
    if (t.dataset.docsAssign) { st.assigning = t.dataset.docsAssign; render(); manager.querySelector('[data-docs-form] input')?.focus(); return; }
    if ('docsCancel' in t.dataset) { st.assigning = null; render(); return; }
    if (t.dataset.docsUnlink) { void setMapping(t.dataset.docsUnlink, { assetId: null }); return; }
    if (t.dataset.docsAuto) { void setMapping(t.dataset.docsAuto, { automatic: true }); }
  }
  manager.addEventListener('click', onClick);
  preview.addEventListener('click', event => { if (event.target === preview) closePreview(); else onClick(event); });
  preview.addEventListener('keydown', event => { if (event.key === 'Escape') closePreview(); });
  manager.addEventListener('submit', event => {
    const form = event.target.closest('[data-docs-form]');
    if (!form) return;
    event.preventDefault();
    const assetId = form.asset.value.trim();
    if (assetId) void setMapping(form.dataset.docsForm, { assetId });
  });
  manager.addEventListener('input', event => {
    if (event.target.matches('[data-docs-search]')) {
      st.search = event.target.value;
      const at = event.target.selectionStart;
      render();
      const input = manager.querySelector('[data-docs-search]');
      input.focus(); input.setSelectionRange(at, at);
    }
  });
  manager.addEventListener('change', event => {
    if (event.target.matches('[data-docs-category]')) { st.category = event.target.value; render(); }
    if (event.target.matches('[data-docs-statusf]')) { st.status = event.target.value; render(); }
  });

  return {
    load,
    openPreview,
    openArtifact,
    closePreview,
    /** Show or hide the Asset Documentation view. */
    toggle(show = manager.hidden) { manager.hidden = !show; if (show) { render(); if (!st.index && !st.loading) void load(); } return show; },
    index: () => st.index,
    state: () => ({ loading: st.loading, error: st.error?.code ?? null, summary: st.index?.summary ?? null, open: !manager.hidden, previewing: !preview.hidden,
      previewSrc: preview.querySelector('iframe')?.getAttribute('src') ?? null, lastSyncedAt: st.index?.lastSyncedAt ?? null }),
    destroy() { manager.remove(); preview.remove(); },
  };
}
