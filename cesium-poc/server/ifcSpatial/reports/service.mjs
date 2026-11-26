/**
 * Report jobs: the request and the assets it covers in, a report snapshot and its files out.
 *
 *   ANALYZING   each asset's documents through the existing document intelligence (analyzeAsset: the ACC
 *               document index, the per-version extraction cache, the user's own ACC access), a few at a time
 *   GENERATING  snapshot → PDF, XLSX and the email draft, each on its own (one failing does not lose the others)
 *   COMPLETED | PARTIALLY_COMPLETED | FAILED | CANCELLED
 *
 * Files live under <dir>/<reportId>/ with a meta.json; they are served only to the session and project that
 * created them, by artifact id (never by path). Reports older than the retention period are deleted. The same
 * request on the same model, documents and inputs returns the existing report instead of generating it again.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApsError } from '../../aps/oauth.mjs';
import { NO_POLICY } from './eligibility.mjs';
import { buildSnapshot, REPORT_KIND } from './snapshot.mjs';
import { buildMaintenanceSnapshot } from './maintenanceSnapshot.mjs';
import { renderReportPdf } from './pdfReport.mjs';
import { renderRegisterXlsx } from './xlsxRegister.mjs';
import { draftEmail, toEml } from './emailDraft.mjs';
import { emailHtmlToText, sanitizeEmailHtml } from './emailHtml.mjs';

export const JOB = Object.freeze({ PENDING: 'PENDING', ANALYZING: 'ANALYZING', GENERATING: 'GENERATING', COMPLETED: 'COMPLETED', PARTIALLY_COMPLETED: 'PARTIALLY_COMPLETED', FAILED: 'FAILED', CANCELLED: 'CANCELLED' });
const MIME = { PDF: 'application/pdf', XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', EML: 'message/rfc822' };
const REPORT_ID = /^RPT-\d{8}-[a-z0-9]{8}$/;
const ARTIFACT_ID = /^[a-z0-9]{12}$/;
const TYPES = /^[A-Z_]{2,40}$/;
const STATUS_CODES = new Set(['POWERED', 'NO_POWER', 'DEGRADED', 'OFFLINE', 'UNKNOWN']);
const str = (v, n = 200) => (v === null || v === undefined ? null : String(v).slice(0, n));
const num = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

/** The request as the server accepts it: known shapes only, bounded lengths. */
export function validateReportBody(body) {
  const r = body?.request ?? {};
  if (!Array.isArray(r.types) || !r.types.length || !r.types.every(t => TYPES.test(t))) throw new ApsError('INVALID_REPORT', 400, 'Name the asset types (request.types).');
  if (!Array.isArray(body.assets)) throw new ApsError('INVALID_REPORT', 400, 'List the assets the request covers (assets).');
  if (body.assets.length > 2000) throw new ApsError('INVALID_REPORT', 400, 'Too many assets for one report.');
  const request = {
    question: str(r.question, 600) ?? '', kind: [REPORT_KIND.ASSET_LIST, REPORT_KIND.MAINTENANCE].includes(r.kind) ? r.kind : REPORT_KIND.INSPECTION,
    // A maintenance report: the investigation it comes from (its question, objective, filters and scope label).
    investigation: r.kind === REPORT_KIND.MAINTENANCE && r.investigation ? { question: str(r.investigation.question, 600), primaryIntent: str(r.investigation.primaryIntent, 40),
      statusFilters: (Array.isArray(r.investigation.statusFilters) ? r.investigation.statusFilters : []).filter(x => STATUS_CODES.has(x)).slice(0, 5), scopeLabel: str(r.investigation.scopeLabel, 120) } : null,
    types: r.types, typeLabels: (r.typeLabels ?? []).slice(0, 10).map(l => ({ singular: str(l?.singular, 60) ?? '', plural: str(l?.plural, 60) ?? '' })),
    outputs: { pdf: Boolean(r.outputs?.pdf), xlsx: Boolean(r.outputs?.xlsx), email: Boolean(r.outputs?.email) },
    recipientGroup: str(r.recipientGroup, 120),
    filters: { condition: r.filters?.condition === 'POOR' ? 'POOR' : null, excludeNoRecords: Boolean(r.filters?.excludeNoRecords), recurring: Boolean(r.filters?.recurring),
      status: STATUS_CODES.has(r.filters?.status) ? r.filters.status : null },
    options: { historyDepth: num(r.options?.historyDepth) && num(r.options.historyDepth) > 0 ? Math.min(num(r.options.historyDepth), 20) : null, includeSpecs: Boolean(r.options?.includeSpecs),
      dueWithinDays: num(r.options?.dueWithinDays) && num(r.options.dueWithinDays) > 0 ? Math.min(num(r.options.dueWithinDays), 3650) : null },
  };
  const assets = body.assets.map(a => ({
    id: str(a?.id, 80), type: TYPES.test(a?.type ?? '') ? a.type : 'OTHER', typeLabel: str(a?.typeLabel, 60), name: str(a?.name, 200), globalId: str(a?.globalId, 40), ifcClass: str(a?.ifcClass, 60),
    zone: str(a?.zone, 80), location: { lon: num(a?.location?.lon), lat: num(a?.location?.lat) }, positionIllustrative: Boolean(a?.positionIllustrative),
    status: a?.status ? { code: STATUS_CODES.has(a.status.code) ? a.status.code : 'UNKNOWN', label: str(a.status.label, 40), source: str(a.status.source, 40), asOf: str(a.status.asOf, 30), evaluatedAt: str(a.status.evaluatedAt, 30) } : null,
  })).filter(a => a.id);
  const context = (Array.isArray(body.context) ? body.context : []).slice(0, 2000).map(c => ({ id: str(c?.id, 80), lon: num(c?.lon), lat: num(c?.lat) })).filter(c => c.lon !== null && c.lat !== null);
  return { request, assets: [...new Map(assets.map(a => [a.id, a])).values()], context, revisionOf: REPORT_ID.test(body.revisionOf ?? '') ? body.revisionOf : null, regenerate: Boolean(body.regenerate),
    area: areaOf(body.area) };
}

/**
 * A report's selected area, as the server resolved it (api.mjs scopes the request before it gets here): kept
 * in the snapshot, so later changes to the selection never change a generated report.
 */
function areaOf(a) {
  if (!a || typeof a !== 'object') return null;
  const ring = a.geometry?.type === 'Polygon' && Array.isArray(a.geometry.coordinates?.[0]) ? a.geometry.coordinates[0].filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).slice(0, 202).map(p => [Number(p[0]), Number(p[1])]) : [];
  if (ring.length < 4) return null;
  const n = v => (Number.isFinite(Number(v)) ? Number(v) : null);
  return { selectionId: str(a.selectionId, 40), label: str(a.label, 80) ?? 'Custom selected area', zone: str(a.zone, 80), versionNumber: n(a.versionNumber), areaM2: n(a.areaM2),
    placementMode: str(a.placementMode, 40), resolvedAt: str(a.resolvedAt, 40), geometry: { type: 'Polygon', coordinates: [ring] }, coordinateSystem: 'EPSG:4326',
    listed: n(a.listed), kept: n(a.kept), dropped: Array.isArray(a.dropped) ? a.dropped.slice(0, 200).map(x => str(x, 80)).filter(Boolean) : [],
    counts: { within: n(a.counts?.within) ?? 0, intersects: n(a.counts?.intersects) ?? 0, crosses: n(a.counts?.crosses) ?? 0, unknown: n(a.counts?.unknown) ?? 0 } };
}

/**
 * Recipient groups → addresses, only as configured (EMAIL_RECIPIENT_GROUPS, JSON: {"Electrical Maintenance Team": ["a@x.com"]}).
 * Without it a group stays a label and the user enters the addresses.
 */
export function recipientDirectory(env = process.env) {
  let map = {};
  try { map = JSON.parse(env.EMAIL_RECIPIENT_GROUPS || '{}'); } catch { map = {}; }
  const norm = s => String(s).toLowerCase().replace(/^the\s+/, '').replace(/\s+/g, ' ').trim();
  const entries = new Map(Object.entries(map).map(([k, v]) => [norm(k), (Array.isArray(v) ? v : [v]).map(String).filter(a => /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(a))]));
  return group => entries.get(norm(group)) ?? null;
}

export function createReportService({ dir, aps, analyzeAsset, listing, now = () => Date.now(), logger = console, retentionDays = Number(process.env.IFC_REPORT_RETENTION_DAYS ?? 7), concurrency = 3, policyPath = null, directory = recipientDirectory() }) {
  const jobs = new Map();
  const stats = { created: 0, reused: 0, pdf: 0, xlsx: 0 };
  const metaPath = id => join(dir, id, 'meta.json');
  const write = (path, data) => { const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, data); renameSync(tmp, path); };
  const ownerOf = (req, projectId) => {
    const sid = aps.sessionId?.(req);
    if (!sid) throw new ApsError('NOT_AUTHENTICATED', 401, 'Sign in to Autodesk to create or open reports.');
    return createHash('sha256').update(`${sid}|${projectId}`).digest('hex');
  };
  const policy = () => {
    if (!policyPath || !existsSync(policyPath)) return { ...NO_POLICY };
    try {
      const p = JSON.parse(readFileSync(policyPath, 'utf8'));
      return { name: str(p.name, 80) ?? 'Configured inspection policy', intervalsByType: Object.fromEntries(Object.entries(p.intervalsByType ?? {}).filter(([k, v]) => TYPES.test(k) && num(v) > 0)),
        conditionRequiresInspection: Boolean(p.conditionRequiresInspection), dueWithinDays: num(p.dueWithinDays) };
    } catch (error) { logger.warn?.(`ifc-spatial reports: inspection policy unreadable: ${error.message}`); return { ...NO_POLICY }; }
  };

  function load(id) {
    if (jobs.has(id)) return jobs.get(id);
    if (!REPORT_ID.test(id) || !existsSync(metaPath(id))) return null;
    const job = JSON.parse(readFileSync(metaPath(id), 'utf8'));
    jobs.set(id, job);
    return job;
  }
  const persist = job => { mkdirSync(join(dir, job.reportId), { recursive: true }); const { req, cancelled, ...rest } = job; write(metaPath(job.reportId), JSON.stringify(rest)); };
  /** The report, if this session and project own it; otherwise "not found" (its existence is not disclosed). */
  async function owned(req, id) {
    const files = await aps.projectFiles(req);
    const job = REPORT_ID.test(id ?? '') ? load(id) : null;
    if (!job || job.owner !== ownerOf(req, files.project.id) || job.projectId !== files.project.id) throw new ApsError('REPORT_NOT_FOUND', 404, 'This report does not exist or belongs to another session.');
    return job;
  }

  function purge() {
    if (!existsSync(dir)) return;
    const cutoff = now() - retentionDays * 86_400_000;
    for (const id of readdirSync(dir)) {
      if (!REPORT_ID.test(id)) continue;
      try { if (statSync(join(dir, id)).mtimeMs < cutoff && !jobs.get(id)?.running) { rmSync(join(dir, id), { recursive: true, force: true }); jobs.delete(id); } } catch { /* already gone */ }
    }
  }

  const step = (job, id, patch) => { const s = job.steps.find(x => x.id === id); if (s) Object.assign(s, patch); job.updatedAt = new Date(now()).toISOString(); };

  async function create(req, fileName, body) {
    const input = validateReportBody(body);
    const files = await aps.projectFiles(req);
    const owner = ownerOf(req, files.project.id);
    const index = await listing(req, fileName);
    if (!index.assets.length) throw new ApsError('MODEL_NOT_READY', 409, `${fileName} has no converted version yet, so its assets cannot be matched to their documents. Load the model first.`);
    const known = new Set(index.assets.map(a => a.assetId));
    const assets = input.assets.filter(a => known.has(a.id));
    const unknown = input.assets.filter(a => !known.has(a.id)).map(a => a.id);
    const key = createHash('sha256').update(JSON.stringify([owner, files.project.id, fileName, index.model?.versionNumber, index.lastSyncedAt, input.request, assets.map(a => [a.id, a.status?.code, a.status?.asOf]), policy(), input.area?.selectionId ?? null])).digest('hex');
    purge();
    if (!input.regenerate) {
      const same = [...jobs.values()].find(j => j.key === key && j.owner === owner && ![JOB.FAILED, JOB.CANCELLED].includes(j.status));
      if (same) {
        stats.reused += 1;
        // The same question again reuses the report and its files, but asks for a new email: a draft that was
        // already sent (or tried) stays in the report's history, and the user gets a fresh draft to send.
        if (input.request.outputs.email && same.snapshot && !same.running && same.emailDraft && same.emailDraft.sendState !== 'DRAFT') {
          same.emailSent = [...(same.emailSent ?? []), ...(same.emailDraft.sent ? [same.emailDraft.sent] : [])];
          same.emailDraft = draftEmail(same.snapshot, { attachments: same.artifacts.filter(a => a.status === 'COMPLETED'), directory });
          persist(same);
        }
        return view(same, { reused: true });
      }
    }
    const prev = input.revisionOf ? load(input.revisionOf) : null;
    const reportId = `RPT-${new Date(now()).toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(6).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '0').slice(0, 8)}`;
    const outputs = input.request.outputs;
    const job = {
      reportId, key, owner, projectId: files.project.id, projectName: files.project.name, fileName, model: { fileName, versionNumber: index.model?.versionNumber ?? null },
      revision: prev && prev.owner === owner ? prev.revision + 1 : 1, revisionOf: prev && prev.owner === owner ? prev.reportId : null,
      createdAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString(), status: JOB.PENDING, request: input.request, unknown, area: input.area,
      steps: [
        { id: 'select', label: 'Identifying matching assets', state: 'done', detail: `${assets.length} ${input.request.typeLabels.map(l => l.plural).join(', ') || 'assets'} ${input.area ? `in the selected area (${input.area.label})` : 'in the model'}` },
        { id: 'documents', label: 'Reviewing ACC documents', state: 'pending', done: 0, total: assets.length },
        { id: 'evaluate', label: input.request.kind === REPORT_KIND.INSPECTION ? 'Evaluating inspection requirements' : input.request.kind === REPORT_KIND.MAINTENANCE ? 'Building the maintenance assessment' : 'Building the asset summary', state: 'pending' },
        ...(outputs.pdf ? [{ id: 'pdf', label: 'Generating PDF report', state: 'pending' }] : []),
        ...(outputs.xlsx ? [{ id: 'xlsx', label: 'Generating Excel register', state: 'pending' }] : []),
        ...(outputs.email ? [{ id: 'email', label: 'Preparing email draft', state: 'pending' }] : []),
      ],
      artifacts: [], emailDraft: null, snapshot: null, error: null, running: true,
    };
    jobs.set(reportId, job);
    stats.created += 1;
    persist(job);
    void run(job, req, { assets, context: input.context, index, project: files.project }).catch(error => {
      job.status = JOB.FAILED; job.error = error?.message ?? String(error); job.running = false; persist(job);
      logger.error?.(`ifc-spatial reports: ${reportId} failed: ${job.error}`);
    });
    return view(job);
  }

  async function run(job, req, { assets, context, index, project }) {
    job.status = JOB.ANALYZING;
    step(job, 'documents', { state: 'running' });
    const results = new Map();
    const queue = [...assets];
    const worker = async () => {
      for (let a = queue.shift(); a; a = queue.shift()) {
        if (job.cancelled) return;
        try { results.set(a.id, { analysis: await analyzeAsset(req, job.fileName, a.id, { listing: index }) }); }
        catch (error) { results.set(a.id, { error: error?.message ?? String(error) }); }
        const s = job.steps.find(x => x.id === 'documents');
        step(job, 'documents', { done: s.done + 1 });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(assets.length, 1)) }, worker));
    if (job.cancelled) { job.status = JOB.CANCELLED; job.running = false; step(job, 'documents', { state: 'cancelled' }); persist(job); return; }
    const analysed = [...results.values()].filter(r => r.analysis);
    step(job, 'documents', { state: 'done', detail: `${analysed.reduce((n, r) => n + r.analysis.documents.analysed, 0)} documents read for ${assets.length} assets${[...results.values()].some(r => r.error) ? `; ${[...results.values()].filter(r => r.error).length} could not be assessed` : ''}` });
    step(job, 'evaluate', { state: 'running' });
    const pol = policy();
    if (job.request.options.dueWithinDays) Object.assign(pol, { dueWithinDays: job.request.options.dueWithinDays });
    const build = job.request.kind === REPORT_KIND.MAINTENANCE ? buildMaintenanceSnapshot : buildSnapshot;
    job.snapshot = build({ reportId: job.reportId, revision: job.revision, revisionOf: job.revisionOf, request: job.request, assets, results, project, model: job.model,
      documentsIndex: index, now: now(), policy: pol, context, area: job.area ?? null });
    if (job.unknown.length) job.snapshot.limitations.unshift(`${job.unknown.length} requested asset id${job.unknown.length === 1 ? ' is' : 's are'} not in the model's asset registry and ${job.unknown.length === 1 ? 'was' : 'were'} left out: ${job.unknown.join(', ')}.`);
    step(job, 'evaluate', { state: 'done', detail: job.request.kind === REPORT_KIND.INSPECTION ? `${job.snapshot.summary.inspectionRequired} require inspection, ${job.snapshot.summary.reviewRecommended} for review`
      : job.request.kind === REPORT_KIND.MAINTENANCE ? `${job.snapshot.summary.withFindings} with documented findings, ${job.snapshot.summary.openActions} actions without verified closure` : `${job.snapshot.summary.included} included` });
    job.status = JOB.GENERATING;
    persist(job);
    const want = job.request.outputs;
    const generate = job.snapshot.summary.included > 0 || job.request.kind === REPORT_KIND.ASSET_LIST;
    if (!generate) for (const id of ['pdf', 'xlsx']) step(job, id, { state: 'skipped', detail: 'No assets meet the criteria: no file generated.' });
    if (want.pdf && generate) await artifact(job, 'PDF');
    if (want.xlsx && generate) await artifact(job, 'XLSX');
    if (want.email) {
      step(job, 'email', { state: 'running' });
      job.emailDraft = draftEmail(job.snapshot, { attachments: job.artifacts.filter(a => a.status === 'COMPLETED'), directory });
      step(job, 'email', { state: 'done' });
    }
    const failed = job.artifacts.some(a => a.status === 'FAILED');
    job.status = failed ? (job.artifacts.some(a => a.status === 'COMPLETED') || want.email ? JOB.PARTIALLY_COMPLETED : JOB.FAILED) : JOB.COMPLETED;
    job.running = false;
    persist(job);
  }

  /** One file from the snapshot; a failure is recorded on that file only, and it can be retried. */
  async function artifact(job, type) {
    const sid = type.toLowerCase();
    step(job, sid, { state: 'running', detail: null });
    const existing = job.artifacts.find(a => a.type === type);
    const a = existing ?? { artifactId: randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '0').slice(0, 12), type, reportId: job.reportId, projectId: job.projectId };
    try {
      const bytes = type === 'PDF' ? await renderReportPdf(job.snapshot, { now: now() }) : await renderRegisterXlsx(job.snapshot);
      mkdirSync(join(dir, job.reportId), { recursive: true });
      write(join(dir, job.reportId, `${a.artifactId}.${type.toLowerCase()}`), bytes);
      Object.assign(a, { filename: type === 'PDF' ? job.snapshot.names.pdfFile : job.snapshot.names.xlsxFile, title: type === 'PDF' ? job.snapshot.names.reportTitle : job.snapshot.names.registerTitle,
        mime: MIME[type], size: bytes.length, createdAt: new Date(now()).toISOString(), status: 'COMPLETED', error: null });
      stats[sid] += 1;
      step(job, sid, { state: 'done' });
    } catch (error) {
      Object.assign(a, { status: 'FAILED', error: error?.message ?? String(error), filename: null, size: null });
      step(job, sid, { state: 'failed', detail: a.error });
      logger.warn?.(`ifc-spatial reports: ${job.reportId} ${type} failed: ${a.error}`);
    }
    if (!existing) job.artifacts.push(a);
    return a;
  }

  /** What the page needs: progress, the summary, the files and the draft (the snapshot for previews). */
  function view(job, extra = {}) {
    const s = job.snapshot;
    return {
      reportId: job.reportId, revision: job.revision, revisionOf: job.revisionOf, status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt, steps: job.steps, error: job.error, ...extra,
      request: job.request, model: job.model, illustrative: s?.illustrative ?? null,
      summary: s?.summary ?? null, coverage: s?.inventoryCoverage ?? null, criteria: s?.appliedCriteria ?? null, limitations: s?.limitations ?? null, names: s?.names ?? null,
      selectedIds: s?.selectedIds ?? [], reviewIds: s?.reviewIds ?? [],
      assets: (s?.assets ?? []).map(a => (s.kind === REPORT_KIND.MAINTENANCE ? { id: a.id, typeLabel: a.typeLabel, classification: a.evidenceAvailability, label: a.row.text, priority: null, reason: a.row.evidence,
        latestInspection: a.latestInspection?.date ?? null, condition: a.latestInspection?.condition?.label ?? null, status: a.statusLabel, nextDue: null, followUp: a.documentedCorrectiveActions[0]?.text ?? null } : {
        id: a.id, typeLabel: a.typeLabel, classification: a.inspection.classification, label: a.inspection.label, priority: a.inspection.priority.level,
        reason: a.inspection.reasons.find(r => r.classification === a.inspection.classification)?.text ?? null, latestInspection: a.latestInspection?.date ?? null,
        condition: a.condition ? `${a.condition.label ?? ''}${Number.isFinite(a.condition.score) ? ` ${a.condition.score}/${a.condition.scale}` : ''}`.trim() : null,
        status: a.operationalStatus?.label ?? null, nextDue: a.inspection.nextInspection.date, followUp: a.inspection.followUps[0]?.text ?? null })),
      maintenance: s?.maintenance ?? null,
      evaluated: s?.evaluated ?? [], sources: s ? s.sources.length : 0, documentsRead: s ? s.documentVersions.filter(d => ['SUCCESS', 'PARTIAL'].includes(d.status)).length : 0,
      artifacts: job.artifacts.map(a => ({ artifactId: a.artifactId, type: a.type, title: a.title ?? null, filename: a.filename, size: a.size, status: a.status, error: a.error, createdAt: a.createdAt ?? null,
        url: a.status === 'COMPLETED' ? `/api/ifc-spatial/reports/${job.reportId}/artifacts/${a.artifactId}?file=${encodeURIComponent(job.fileName)}` : null })),
      emailDraft: job.emailDraft, emailSent: job.emailSent ?? [], emlUrl: job.emailDraft ? `/api/ifc-spatial/reports/${job.reportId}/email.eml?file=${encodeURIComponent(job.fileName)}` : null,
    };
  }

  async function get(req, id) { return view(await owned(req, id)); }
  async function cancel(req, id) {
    const job = await owned(req, id);
    if (job.running) job.cancelled = true;
    return view(job);
  }
  async function retry(req, id, type) {
    const job = await owned(req, id);
    if (!['PDF', 'XLSX'].includes(type)) throw new ApsError('INVALID_ARTIFACT', 400, 'Retry a PDF or XLSX file.');
    if (!job.snapshot) throw new ApsError('REPORT_NOT_READY', 409, 'The report has no snapshot to generate from.');
    if (job.running) throw new ApsError('REPORT_BUSY', 409, 'The report is still being generated.');
    const sid = type.toLowerCase();
    if (!job.steps.some(s => s.id === sid)) job.steps.push({ id: sid, label: type === 'PDF' ? 'Generating PDF report' : 'Generating Excel register', state: 'pending' });
    job.request.outputs[sid] = true;
    await artifact(job, type);
    if (job.emailDraft) job.emailDraft = { ...job.emailDraft, attachmentIds: [...new Set([...job.emailDraft.attachmentIds, ...job.artifacts.filter(a => a.type === type && a.status === 'COMPLETED').map(a => a.artifactId)])] };
    job.status = job.artifacts.some(a => a.status === 'FAILED') ? JOB.PARTIALLY_COMPLETED : JOB.COMPLETED;
    persist(job);
    return view(job);
  }

  /**
   * Edit or regenerate the draft. The report and its files are not touched: only the draft changes.
   * {recipientGroup, subject, body, attachmentIds} edit; {regenerate: true, style, recipientGroup} writes it again.
   */
  async function updateEmail(req, id, body) {
    const job = await owned(req, id);
    if (!job.snapshot) throw new ApsError('REPORT_NOT_READY', 409, 'The report is not ready yet.');
    const state = job.emailDraft?.sendState;
    // A sent (or possibly sent) draft is a record: it is not edited; a new draft can be made from it.
    if (body.newDraft) {
      if (!job.emailDraft) throw new ApsError('NO_DRAFT', 404, 'This report has no email draft.');
      if (state === 'SENDING') throw new ApsError('SEND_IN_PROGRESS', 409, 'The email is being sent.');
      job.emailSent = [...(job.emailSent ?? []), ...(job.emailDraft.sent ? [job.emailDraft.sent] : [])];
      job.emailDraft = { ...job.emailDraft, sendState: 'DRAFT', sent: null, lastAttempt: null, edited: true, draftId: randomBytes(9).toString('base64url'), updatedAt: new Date(now()).toISOString() };
      persist(job);
      return view(job);
    }
    if (['SENT', 'SENDING', 'SEND_STATUS_UNKNOWN'].includes(state)) throw new ApsError(state === 'SENDING' ? 'SEND_IN_PROGRESS' : 'DRAFT_LOCKED', 409,
      state === 'SENDING' ? 'The email is being sent.' : 'This draft was sent (or its send status is unknown). Create a new draft from it to change it.');
    const list = v => (v === undefined ? undefined : (Array.isArray(v) ? v : String(v ?? '').split(/[,;\s]+/)).map(x => String(x).trim()).filter(Boolean).slice(0, 50).map(x => x.slice(0, 254)));
    const [to, cc, bcc] = [list(body.to), list(body.cc), list(body.bcc)];
    const files = job.artifacts.filter(a => a.status === 'COMPLETED');
    const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds.filter(x => files.some(f => f.artifactId === x)) : job.emailDraft?.attachmentIds ?? files.map(f => f.artifactId);
    const attachments = files.filter(f => attachmentIds.includes(f.artifactId));
    const recipientGroup = body.recipientGroup !== undefined ? str(body.recipientGroup, 120) : job.emailDraft?.recipientGroup ?? job.request.recipientGroup;
    if (body.regenerate || !job.emailDraft) {
      job.emailDraft = draftEmail(job.snapshot, { recipientGroup, style: body.style === 'short' ? 'short' : body.style === 'standard' ? 'standard' : job.emailDraft?.style ?? 'standard', attachments,
        to: to ?? job.emailDraft?.to ?? [], cc: cc ?? job.emailDraft?.cc ?? [], bcc: bcc ?? job.emailDraft?.bcc ?? [], directory });
    } else {
      // A formatted body is kept only as sanitized HTML; its plain text is derived from it.
      const html = body.bodyHtml !== undefined ? sanitizeEmailHtml(body.bodyHtml) : null;
      job.emailDraft = { ...job.emailDraft, recipientGroup, subject: body.subject !== undefined ? str(body.subject, 300) ?? '' : job.emailDraft.subject,
        body: html !== null ? emailHtmlToText(html) : body.body !== undefined ? str(body.body, 20_000) ?? '' : job.emailDraft.body,
        bodyHtml: html !== null ? html : body.body !== undefined ? null : job.emailDraft.bodyHtml ?? null,
        attachmentIds: attachments.map(a => a.artifactId), attachments: attachments.map(a => ({ artifactId: a.artifactId, filename: a.filename })),
        to: to ?? job.emailDraft.to ?? [], cc: cc ?? job.emailDraft.cc ?? [], bcc: bcc ?? job.emailDraft.bcc ?? [],
        edited: body.subject !== undefined || body.body !== undefined ? true : job.emailDraft.edited ?? false, updatedAt: new Date(now()).toISOString() };
    }
    if (!job.request.outputs.email) { job.request.outputs.email = true; if (!job.steps.some(s => s.id === 'email')) job.steps.push({ id: 'email', label: 'Preparing email draft', state: 'done' }); }
    persist(job);
    return view(job);
  }

  async function sendArtifact(req, res, id, artifactId, { download }) {
    const job = await owned(req, id);
    const a = ARTIFACT_ID.test(artifactId ?? '') ? job.artifacts.find(x => x.artifactId === artifactId && x.status === 'COMPLETED') : null;
    if (!a) throw new ApsError('ARTIFACT_NOT_FOUND', 404, 'This file does not exist.');
    const bytes = readFileSync(join(dir, job.reportId, `${a.artifactId}.${a.type.toLowerCase()}`));
    res.writeHead(200, { 'content-type': a.mime, 'content-length': String(bytes.length), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
      'content-disposition': `${download || a.type !== 'PDF' ? 'attachment' : 'inline'}; filename="${a.filename}"` });
    res.end(bytes);
  }
  async function sendEml(req, res, id) {
    const job = await owned(req, id);
    if (!job.emailDraft) throw new ApsError('NO_DRAFT', 404, 'This report has no email draft.');
    const files = job.artifacts.filter(a => a.status === 'COMPLETED' && job.emailDraft.attachmentIds.includes(a.artifactId))
      .map(a => ({ filename: a.filename, mime: a.mime, bytes: readFileSync(join(dir, job.reportId, `${a.artifactId}.${a.type.toLowerCase()}`)) }));
    const bytes = toEml(job.emailDraft, files, { now: now() });
    res.writeHead(200, { 'content-type': MIME.EML, 'content-length': String(bytes.length), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
      'content-disposition': `attachment; filename="${job.snapshot.names.emlFile}"` });
    res.end(bytes);
  }
  /**
   * For sending (server/gmail/): this user's report, its saved draft and the files the draft attaches, read
   * from the report's own store by artifact id. Missing files are named, never skipped silently.
   */
  async function sendContext(req, fileName, id, { history = false } = {}) {
    const job = await owned(req, id);
    if (fileName && job.fileName !== fileName) throw new ApsError('REPORT_NOT_FOUND', 404, 'This report does not exist or belongs to another session.');
    if (!history && !job.emailDraft) throw new ApsError('NO_DRAFT', 404, 'This report has no email draft.');
    const files = [], missing = [];
    for (const aid of job.emailDraft?.attachmentIds ?? []) {
      const a = job.artifacts.find(x => x.artifactId === aid);
      const path = a ? join(dir, job.reportId, `${a.artifactId}.${a.type.toLowerCase()}`) : null;
      if (!a || a.status !== 'COMPLETED' || !existsSync(path)) { missing.push(a?.filename ?? aid); continue; }
      files.push({ artifactId: a.artifactId, filename: a.filename, mime: a.mime, bytes: readFileSync(path) });
    }
    return { owner: job.owner, projectId: job.projectId, reportId: job.reportId, revision: job.revision, fileName: job.fileName, draft: job.emailDraft, files, missing, illustrative: Boolean(job.snapshot?.illustrative) };
  }
  /** A send attempt's outcome on the draft: its state, and the sent record (kept as it was sent). */
  async function recordSend(req, fileName, id, { state, attemptId, sent = null, failure = null }) {
    const job = await owned(req, id);
    if (!job.emailDraft) return;
    job.emailDraft = { ...job.emailDraft, sendState: state, lastAttempt: { attemptId, state, failure, at: new Date(now()).toISOString() }, ...(sent ? { sent } : {}) };
    persist(job);
  }

  /** The snapshot itself (for the register preview), owner only. */
  async function snapshotOf(req, id) { const job = await owned(req, id); return job.snapshot ? { ...job.snapshot, context: undefined } : null; }

  return { create, get, cancel, retry, updateEmail, sendArtifact, sendEml, snapshotOf, sendContext, recordSend, stats: () => ({ ...stats }), _jobs: jobs };
}
