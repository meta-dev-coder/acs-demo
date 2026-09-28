/**
 * Answering questions about the drawn area, from the resolved context alone.
 *
 * The spatial query has already decided what is in the box. This turns that into English. It is
 * deliberately not a language model's job: "are there any incidents here" has one correct answer,
 * it is already computed, and a model asked to infer it from coordinates would sometimes be wrong
 * in a way that reads exactly like being right.
 *
 * Every sentence below is countable from the context. Where the answer is nothing, it says nothing
 * — "no incidents in this area" is a real answer, and substituting the corridor's other incidents
 * for it would answer a question the operator did not ask.
 *
 * Pure: question and context in, text and offered actions out.
 */

import { CARRIAGEWAY_LABELS } from '../liveOps/carriagewayModel.js';
import { isOpenRecord } from './spatialQuery.js';

/**
 * Wording that means "everywhere", which must win over the drawn area.
 *
 * An operator who has an area selected and then asks about the whole corridor means the whole
 * corridor. Silently scoping that to the box would be the single most misleading thing this feature
 * could do, so it is checked before anything else.
 */
const CORRIDOR_WIDE = /\b(entire|whole|all of|across the|corridor[- ]wide|anywhere)\b.*\b(corridor|i[- ]?595)\b|\b(corridor[- ]wide)\b/i;

/** The area questions this answers, most specific first — "open work orders" before "work". */
const INTENTS = Object.freeze([
  { id: 'workOrders', match: /\bwork[- ]?orders?\b/i },
  { id: 'maintenance', match: /\b(maintenance|tickets?|tasks?|inspections?|repairs?)\b/i },
  { id: 'incidents', match: /\bincidents?|crash(es)?\b/i },
  { id: 'closures', match: /\bclosures?|closed\b/i },
  { id: 'cameras', match: /\bcameras?\b|\bcctv\b/i },
  { id: 'signs', match: /\b(message signs?|dms|signs?)\b/i },
  { id: 'roadway', match: /\b(segments?|sections?|which road|what road|eastbound|westbound|express|carriageway|direction)\b/i },
  { id: 'assets', match: /\bassets?\b/i },
  { id: 'summary', match: /\b(happening|summary|overview|going on|tell me about|what.s here|status)\b/i },
]);

/** Words that mean "the area I drew". A question with none of them is not about the area. */
const AREA_WORDS = /\b(here|this area|the area|selected area|this region|this box|this rectangle|in here|this selection)\b/i;

/**
 * Which area question this is, if any.
 *
 * @param {string} question
 * @param {boolean} hasArea whether an area is currently selected
 * @returns {string|null} the intent id, or null to let the normal routing handle it
 */
export function parseAreaQuestion(question, hasArea) {
  if (!hasArea || !question) return null;
  const text = String(question);
  // §40: an explicit corridor-wide scope overrides the selection rather than being narrowed by it.
  if (CORRIDOR_WIDE.test(text)) return null;
  const aboutArea = AREA_WORDS.test(text);
  const intent = INTENTS.find(entry => entry.match.test(text));
  if (!intent) return aboutArea ? 'summary' : null;
  // "Are there incidents?" with an area up means in the area; the words do not have to be there,
  // but a question that names somewhere else entirely is left alone.
  return intent.id;
}

const count = (n, singular, plural = `${singular}s`) => `${n} ${n === 1 ? singular : plural}`;
const lines = parts => parts.filter(Boolean).join('\n');

/** "I-595 Eastbound · Section 03", the way the rest of the app writes a place. */
function segmentLine(segment) {
  return `• ${CARRIAGEWAY_LABELS[segment.carriageway] ?? segment.carriageway}${segment.sectionId ? ` — ${segment.sectionLabel}` : ''}`;
}

/** What the area covers, in the words §24 asks for — never just "I-595". */
export function describeRoadway(context) {
  const { roadway } = context;
  if (!roadway.intersectsI595) {
    return 'The selected area does not intersect the modelled I-595 corridor.';
  }
  const sections = roadway.segments.map(segmentLine);
  const express = roadway.includesExpress
    ? '• I-595 Express — operational sections are not defined for Express, so no section is named'
    : null;
  return lines(['The selected area intersects:', ...sections, express]);
}

/** One class of live event, or an honest nothing. */
function eventSection(context, group, label) {
  const found = context.liveEvents[group] ?? [];
  if (!found.length) return `No ${label} are inside the selected area.`;
  return lines([`${count(found.length, label.replace(/s$/, ''))} inside the selected area:`,
    ...found.map(event => `• ${event.title}${event.severity ? ` · ${event.severity}` : ''}${event.status ? ` · ${event.status}` : ''}${event.carriagewayLabel ? ` · ${event.carriagewayLabel}` : ''}`)]);
}

/** The assets, grouped by the category the explorer already names them with. */
export function describeAssets(context) {
  const { assets } = context;
  if (!assets.total) return 'No assets from the loaded layers fall inside the selected area.';
  const byCategory = Object.entries(assets.byCategory).sort((a, b) => b[1] - a[1]);
  return lines([`${count(assets.total, 'asset')} inside the selected area:`,
    ...byCategory.map(([category, n]) => `• ${n} × ${category}`)]);
}

/** Maintenance, stating plainly when a record is here because its ASSET is here. */
export function describeMaintenance(context, { openOnly = false, group = null } = {}) {
  // Keyed by the context's own field, labelled in the words an operator uses for it — the two are
  // not the same string, and printing the field name gave "8 open workOrders".
  const LABELS = { workOrders: ['work order', 'work orders'], tickets: ['ticket', 'tickets'],
    tasks: ['task', 'tasks'], inspections: ['inspection', 'inspections'],
    damagedAssets: ['damaged asset', 'damaged assets'], incidents: ['incident', 'incidents'] };
  const groups = group ? [group] : ['workOrders', 'tickets', 'tasks', 'inspections', 'damagedAssets'];
  const blocks = [];
  for (const key of groups) {
    const [singular, plural] = LABELS[key] ?? [key, key];
    const all = context.maintenance[key] ?? [];
    const found = openOnly ? all.filter(isOpenRecord) : all;
    if (!found.length) continue;
    blocks.push(lines([`${count(found.length, openOnly ? `open ${singular}` : singular, openOnly ? `open ${plural}` : plural)}:`,
      ...found.slice(0, 8).map(record => `• ${record.id}${record.title ? ` · ${record.title}` : ''}${record.status ? ` · ${record.status}` : ''}${record.priority ? ` · priority ${record.priority}` : ''}${record.locatedVia === 'asset' && record.assetId ? ` · via asset ${record.assetId}` : ''}`),
      found.length > 8 ? `…and ${found.length - 8} more.` : null]));
  }
  if (!blocks.length) {
    return openOnly
      ? 'No open work is recorded against anything in the selected area.'
      : 'No maintenance records are associated with the selected area.';
  }
  return blocks.join('\n\n');
}

/** The whole picture — §23. */
export function describeSummary(context) {
  const events = context.liveEvents;
  const operations = [
    `• ${count(events.incidents.length, 'incident')}`,
    `• ${count(events.closures.length, 'closure')}`,
    `• ${count(events.disabledVehicles.length, 'disabled vehicle')}`,
    `• ${count(events.congestion.length, 'congestion report')}`,
    `• ${count(events.construction.length, 'construction zone')}`,
  ];
  const open = context.totals.openWorkOrders;
  const maintenance = context.totals.maintenance
    ? `• ${count(context.totals.maintenance, 'maintenance record')}${open ? `, ${count(open, 'open work order')}` : ''}`
    : '• No maintenance records';
  return lines([
    describeRoadway(context),
    '',
    'Current operations:',
    ...operations,
    '',
    'Assets in the area:',
    context.assets.total
      ? Object.entries(context.assets.byCategory).sort((a, b) => b[1] - a[1]).map(([category, n]) => `• ${n} × ${category}`).join('\n')
      : '• None from the loaded layers',
    '',
    'Maintenance:',
    maintenance,
  ]);
}

/**
 * The answer for one area question.
 *
 * @returns {string|null} null when the intent is not one this answers
 */
export function answerAreaQuestion(intent, context) {
  if (!context) return null;
  switch (intent) {
    case 'summary': return describeSummary(context);
    case 'roadway': return describeRoadway(context);
    case 'incidents': return eventSection(context, 'incidents', 'incidents');
    case 'closures': return eventSection(context, 'closures', 'closures');
    case 'assets': return describeAssets(context);
    case 'cameras': return describeAssetCategory(context, /camera/i, 'traffic cameras');
    case 'signs': return describeAssetCategory(context, /sign/i, 'message signs');
    case 'workOrders': return describeMaintenance(context, { openOnly: true, group: 'workOrders' });
    case 'maintenance': return describeMaintenance(context);
    default: return null;
  }
}

/** One category of asset, by the explorer's own label for it. */
function describeAssetCategory(context, pattern, label) {
  const found = context.assets.records.filter(record => pattern.test(record.category));
  if (!found.length) return `No ${label} are inside the selected area.`;
  return lines([`${count(found.length, label.replace(/s$/, ''))} inside the selected area:`,
    ...found.slice(0, 10).map(record => `• ${record.name}`),
    found.length > 10 ? `…and ${found.length - 10} more.` : null]);
}

/** The short line the panel shows while an area is up — §38. */
export function areaIndicatorText(context) {
  if (!context) return '';
  const parts = [`${context.totals.sections || 'no'} ${context.totals.sections === 1 ? 'section' : 'sections'}`,
    `${context.totals.assets} ${context.totals.assets === 1 ? 'asset' : 'assets'}`];
  if (context.totals.events) parts.push(`${context.totals.events} live`);
  if (context.totals.openWorkOrders) parts.push(`${context.totals.openWorkOrders} open WO`);
  return `Selected area · ${parts.join(' · ')}`;
}

/** The summary block shown as soon as the area is drawn — §18, before any question is asked. */
export function areaSummaryLines(context) {
  if (!context) return [];
  const { roadway, totals, liveEvents } = context;
  const where = roadway.intersectsI595
    ? [...roadway.segments.map(segment => `${CARRIAGEWAY_LABELS[segment.carriageway]} · ${segment.sectionLabel}`),
      ...(roadway.includesExpress ? ['I-595 Express'] : [])]
    : ['Does not intersect the modelled I-595 corridor'];
  return [
    ...where,
    `${totals.sections} roadway ${totals.sections === 1 ? 'section' : 'sections'}`,
    `${totals.assets} ${totals.assets === 1 ? 'asset' : 'assets'}`,
    `${liveEvents.closures.length} ${liveEvents.closures.length === 1 ? 'closure' : 'closures'}`,
    `${liveEvents.incidents.length} ${liveEvents.incidents.length === 1 ? 'incident' : 'incidents'}`,
    `${totals.openWorkOrders} open work ${totals.openWorkOrders === 1 ? 'order' : 'orders'}`,
  ];
}

/** What to offer once an area exists — §22. */
export const AREA_SUGGESTIONS = Object.freeze([
  'What is happening in this area?',
  'Are there any incidents here?',
  'What closures affect this area?',
  'Which roadway segments are selected?',
  'What assets are here?',
  'Are there open work orders here?',
]);
