/**
 * Historical chain: Incident -> Ticket -> Task(s) -> Work Order -> Inspection for every Bentley
 * historical incident, as rows of "SDNA Florida I595 Historical Chain". Bentley's own data links only
 * Ticket -> Task -> Work Order; the other links are inferred from the same asset within 90 days or
 * filled with synthetic steps, and every row says which. Pure and deterministic; Bentley classes are
 * only read, and links to them are plain String ids.
 */
import { HISTORICAL_CHAIN_CLASS, sdnaClassDefinition, toDcDateTime } from './classes.mjs';
import { classifySubtype, loadWorkflowConfig } from './workflow.mjs';
import { attributesOf, field, assetKey } from '../../src/maintenance/maintenanceRecords.js';

export const CHAIN_STEPS = Object.freeze(['incident', 'ticket', 'task', 'work_order', 'inspection']);
export const LINK_METHODS = Object.freeze(['root', 'bentley_link', 'inferred_same_asset', 'synthetic']);
export const LINK_WINDOW_DAYS = 90;
export const CHAIN_TIME_ZONE = 'America/New_York';

export const BENTLEY_CLASS = Object.freeze({
  INCIDENTS: 'Florida I595 Incidents', TICKETS: 'Florida I595 Tickets', TASKS: 'Florida I595 Tasks',
  WORK_ORDERS: 'Florida I595 Work Orders', ITS_INSPECTIONS: 'Florida I595 ITS Inspections',
  ROADWAY_INSPECTIONS: 'Florida I595 Roadway Inspections', SAFETY_INSPECTIONS: 'Florida I595 Safety Inspections',
});

/** sources key -> Bentley class, in the order the tool reads them. */
export const SOURCE_CLASSES = Object.freeze({
  incidents: BENTLEY_CLASS.INCIDENTS, tickets: BENTLEY_CLASS.TICKETS, tasks: BENTLEY_CLASS.TASKS, workOrders: BENTLEY_CLASS.WORK_ORDERS,
  itsInspections: BENTLEY_CLASS.ITS_INSPECTIONS, roadwayInspections: BENTLEY_CLASS.ROADWAY_INSPECTIONS,
  safetyInspections: BENTLEY_CLASS.SAFETY_INSPECTIONS,
});

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NA = 'NA';

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/i;
const DMY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

function wallFromParts(y, mo, d, h = 0, mi = 0, s = 0) {
  if (y < 1901 || mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(ms);
  return check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d ? ms : null;
}

const zoneOffsetMs = (zone) => {
  if (!zone || /^z$/i.test(zone)) return 0;
  const m = zone.match(/^([+-])(\d{2}):?(\d{2})$/);
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
};

/**
 * A date as found in the Bentley data (ISO, dd/mm/yyyy, dd/mm/yyyy HH:MM, DataConnect's zoned read-back)
 * -> wall-clock milliseconds (the wall time encoded as UTC), or null. `time` fills in a date without
 * a time of day. Years before 1901 ("1900-01-00", Excel's zero date) are invalid.
 */
export function parseChainDate(value, time = null) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  let ms = null;
  let hasTime = false;
  let m = text.match(ISO);
  if (m) {
    const [, y, mo, d, h, mi, s, , zone] = m;
    ms = wallFromParts(+y, +mo, +d, +(h ?? 0), +(mi ?? 0), +(s ?? 0));
    if (ms !== null && zone) ms -= zoneOffsetMs(zone);
    hasTime = h !== undefined && !(+h === 0 && +mi === 0 && +(s ?? 0) === 0);
  } else if ((m = text.match(DMY))) {
    const [, d, mo, y, h, mi, s] = m;
    ms = wallFromParts(+y, +mo, +d, +(h ?? 0), +(mi ?? 0), +(s ?? 0));
    hasTime = h !== undefined && !(+h === 0 && +mi === 0 && +(s ?? 0) === 0);
  }
  if (ms === null) return null;
  const t = typeof time === 'string' ? time.trim().match(TIME) : null;
  if (!hasTime && t && +t[1] < 24 && +t[2] < 60 && +(t[3] ?? 0) < 60) {
    ms += (+t[1] * 3600 + +t[2] * 60 + +(t[3] ?? 0)) * 1000;
  }
  return ms;
}

export function daysBetween(fromWall, toWall) {
  return Math.floor(toWall / DAY) - Math.floor(fromWall / DAY);
}

const zoneFormatters = new Map();
function wallOfInstant(instant, timeZone) {
  if (!zoneFormatters.has(timeZone)) {
    zoneFormatters.set(timeZone, new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }));
  }
  const p = Object.fromEntries(zoneFormatters.get(timeZone).formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}

/** Wall-clock ms in `timeZone` (default America/New_York) -> DataConnect DateTime (UTC, whole seconds). */
export function wallToDcDateTime(wallMs, timeZone = CHAIN_TIME_ZONE) {
  if (!Number.isFinite(wallMs)) return null;
  const whole = Math.floor(wallMs / 1000) * 1000;
  let instant = whole - (wallOfInstant(whole, timeZone) - whole);
  instant = whole - (wallOfInstant(instant, timeZone) - instant);
  return toDcDateTime(instant);
}

const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The earliest candidate 0..windowDays calendar days after the anchor; ties go to the smaller id. */
export function pickFollowing(candidates, anchorWall, { dateOf, idOf, windowDays = LINK_WINDOW_DAYS }) {
  if (!Number.isFinite(anchorWall)) return null;
  let best = null;
  for (const record of candidates ?? []) {
    const date = dateOf(record);
    if (!Number.isFinite(date)) continue;
    const days = daysBetween(anchorWall, date);
    if (days < 0 || days > windowDays) continue;
    const id = String(idOf(record));
    if (!best || days < best.days || (days === best.days && byId(id, best.id) < 0)) best = { record, days, date, id };
  }
  return best && { record: best.record, days: best.days, date: best.date };
}

function fnv1a32(value) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(String(value))) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

const str = (value) => {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
};
const idOf = (row, ...names) => str(field(row, ...names, 'code')) ?? str(row?.keyInSource);
const num = (value) => (value === null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));
const inFlorida = (lon, lat) => lon >= -88 && lon <= -79 && lat >= 24 && lat <= 31;

function incidentPosition(row) {
  const pairs = [['x_coordinate (from asset)', 'y_coordinate (from asset)'], ['x_coordinates', 'y_coordinates'], ['x coordinates', 'y coordinates']];
  for (const [xk, yk] of pairs) {
    const x = num(field(row, xk)), y = num(field(row, yk));
    if (x === null || y === null) continue;
    if (inFlorida(x, y)) return [x, y];
    if (inFlorida(y, x)) return [y, x];
  }
  const geometry = row?.geoDetails?.source ?? row?.geometry ?? attributesOf(row).geometry;
  const [x, y] = Array.isArray(geometry?.coordinates) ? geometry.coordinates.map(num) : [];
  if (x !== null && y !== null && x !== undefined && y !== undefined && inFlorida(x, y)) return [x, y];
  return null;
}

function normalize(sources) {
  const list = (key) => (Array.isArray(sources?.[key]) ? sources[key] : []);
  const incidents = list('incidents').map((row) => ({
    id: idOf(row, 'incident_id'),
    date: parseChainDate(field(row, 'incident_date'), field(row, 'incident_time')),
    assetId: assetKey(field(row, 'damaged_asset_id')),
    segment: str(field(row, 'Segment', 'segment name')),
    type: str(field(row, 'incident_type')),
    notes: [field(row, 'location_notes'), field(row, 'notes'), field(row, 'root_cause_category')].filter(Boolean).join(' '),
    severe: /^y/i.test(str(field(row, 'injuries_y_n')) ?? '') || (num(field(row, 'fatalities')) ?? 0) > 0
      || /^y/i.test(str(field(row, 'lane_closure_y_n')) ?? ''),
    position: incidentPosition(row),
    content: canonical(attributesOf(row)),
  })).filter((i) => i.id);
  const tickets = list('tickets').map((row) => ({
    id: idOf(row, 'Ticket ID'), assetId: assetKey(field(row, 'Asset ID')),
    date: parseChainDate(field(row, 'Ticket Opened Date'), field(row, 'Ticket Opened Time')),
    summary: str(field(row, 'Issue Summary', 'Issue Category')), status: str(field(row, 'Ticket Status')), priority: str(field(row, 'Priority')),
  })).filter((t) => t.id);
  const tasks = list('tasks').map((row) => ({
    id: idOf(row, 'Task ID'), ticketId: str(field(row, 'Related Ticket ID')), assetId: assetKey(field(row, 'Asset ID')),
    date: parseChainDate(field(row, 'Task Date')),
    summary: str(field(row, 'Task Notes', 'Task Type')), status: str(field(row, 'Task Status')),
    team: str(field(row, 'Assigned Team')), type: str(field(row, 'Task Type')),
  })).filter((t) => t.id);
  const workOrders = list('workOrders').map((row) => ({
    id: idOf(row, 'Work Order ID'), ticketId: str(field(row, 'Related Ticket ID')), taskId: str(field(row, 'Related Task ID')),
    assetId: assetKey(field(row, 'Asset ID')), date: parseChainDate(field(row, 'Work Order Open Date')),
    summary: str(field(row, 'Work Description', 'Repair Category')), status: str(field(row, 'Work Order Status')),
    priority: str(field(row, 'Priority')), type: str(field(row, 'Work Type')),
  })).filter((w) => w.id);
  const inspections = [
    ['itsInspections', BENTLEY_CLASS.ITS_INSPECTIONS], ['roadwayInspections', BENTLEY_CLASS.ROADWAY_INSPECTIONS],
    ['safetyInspections', BENTLEY_CLASS.SAFETY_INSPECTIONS],
  ].flatMap(([key, className]) => list(key).map((row) => ({
    id: idOf(row, 'record_id', 'inspection_id'), className, assetId: assetKey(field(row, 'asset_id')),
    date: parseChainDate(field(row, 'inspection_date', 'date'), field(row, 'inspection_time', 'time')),
    summary: str(field(row, 'issue_summary', 'safety_issue_description_v3', 'observed_condition')),
    result: str(field(row, 'inspection_result', 'pass_fail', 'pass_or_fail')),
    condition: str(field(row, 'asset_condition', 'observed_condition')),
  }))).filter((i) => i.id);
  return { incidents, tickets, tasks, workOrders, inspections };
}

const groupBy = (items, keyOf) => {
  const map = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  for (const group of map.values()) group.sort((a, b) => byId(a.id, b.id));
  return map;
};

const earliest = (items) => [...items].sort((a, b) => {
  const da = Number.isFinite(a.date) ? a.date : Infinity, db = Number.isFinite(b.date) ? b.date : Infinity;
  return (Math.floor(da / DAY) - Math.floor(db / DAY)) || byId(a.id, b.id);
})[0] ?? null;

const canonical = (value) => JSON.stringify(value, (_, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));

const incidentNumber = (id) => id.match(/(\d+)$/)?.[1] ?? id.replace(/[^A-Za-z0-9]+/g, '-');
const later = (base, offset) => (Number.isFinite(base) ? base + offset : null);

export function buildHistoricalChains(sources, { config = loadWorkflowConfig(), timeZone = CHAIN_TIME_ZONE } = {}) {
  const def = sdnaClassDefinition(HISTORICAL_CHAIN_CLASS);
  const stringAttrs = def.attributes.filter((a) => a.type === 'String' && !a.core).map((a) => a.name);
  const { incidents, tickets, tasks, workOrders, inspections } = normalize(sources);
  const ticketsByAsset = groupBy(tickets, (t) => t.assetId);
  const tasksByTicket = groupBy(tasks, (t) => t.ticketId);
  const wosByTicket = groupBy(workOrders, (w) => w.ticketId);
  const wosByTask = groupBy(workOrders, (w) => w.taskId);
  const inspectionsByAsset = groupBy(inspections, (i) => i.assetId);
  const taskTemplates = config.tasks.INCIDENT;

  const rows = [];
  // Bentley reuses some incident ids for different incidents: each gets its own chain, the later ones
  // suffixed -DUP<n> (ordered by date, then content, so input order never matters).
  const sorted = [...incidents].sort((a, b) => byId(a.id, b.id)
    || (Number.isFinite(a.date) ? a.date : Infinity) - (Number.isFinite(b.date) ? b.date : Infinity) || byId(a.content, b.content));
  const occurrences = new Map();
  for (const inc of sorted) occurrences.set(inc.id, (occurrences.get(inc.id) ?? 0) + 1);
  const seen = new Map();
  for (const inc of sorted) {
    const occurrence = (seen.get(inc.id) ?? 0) + 1;
    seen.set(inc.id, occurrence);
    const suffix = occurrence > 1 ? `-DUP${occurrence}` : '';
    const chainRef = `${inc.id}${suffix}`;
    const n = `${incidentNumber(inc.id)}${suffix}`;
    const h = fnv1a32(chainRef);
    const subtype = classifySubtype({ event_type: 'INCIDENT', title: inc.type ?? '', description: inc.notes }, config);
    const priority = inc.severe ? 'High' : 'Medium';
    const geo = inc.position
      ? { geometry: { type: 'Point', coordinates: [...inc.position] }, x_coordinates: inc.position[0], y_coordinates: inc.position[1] }
      : {};
    let order = 0;
    let lastDate = inc.date;
    const push = (step, fields) => {
      order += 1;
      const date = fields.date;
      if (Number.isFinite(date)) lastDate = Math.max(lastDate ?? date, date);
      const confidence = { root: 'High', bentley_link: 'High', inferred_same_asset: 'Medium', synthetic: 'Synthetic' }[fields.link_method];
      const key = `CHAIN-${chainRef}-${order}-${step}`;
      const row = {
        keyInSource: key, code: key,
        name: `${chainRef} ${step.replace('_', ' ')} ${fields.record_id}`,
        description: `${fields.link_method === 'synthetic' ? 'Synthetic' : 'Bentley'} ${step.replace('_', ' ')} of ${chainRef}: ${fields.link_detail}`,
        chain_id: `CHAIN-${chainRef}`, incident_id: inc.id, step, step_order: order,
        record_id: fields.record_id, parent_record_id: fields.parent ?? NA,
        record_class: fields.record_class ?? 'synthetic',
        link_method: fields.link_method, link_detail: fields.link_detail, confidence,
        is_synthetic: fields.link_method === 'synthetic',
        asset_id: fields.assetId ?? inc.assetId ?? NA,
        segment: inc.segment ?? NA,
        ...(Number.isFinite(date) ? { step_date: wallToDcDateTime(date, timeZone) } : {}),
        summary: fields.summary, status: fields.status, priority: fields.priority, assigned_team: fields.team,
        work_type: fields.workType, inspection_result: fields.result, asset_condition: fields.condition,
        ...geo,
      };
      for (const name of stringAttrs) if (typeof row[name] !== 'string' || row[name].trim() === '') row[name] = NA;
      rows.push(row);
      return row;
    };

    push('incident', {
      record_id: inc.id, record_class: BENTLEY_CLASS.INCIDENTS, link_method: 'root',
      link_detail: occurrences.get(inc.id) > 1
        ? `chain root; Bentley id ${inc.id} is shared by ${occurrences.get(inc.id)} incidents (this is occurrence ${occurrence})` : 'chain root',
      date: inc.date, summary: inc.type, priority,
    });

    const ticketHit = inc.assetId && Number.isFinite(inc.date)
      ? pickFollowing(ticketsByAsset.get(inc.assetId), inc.date, { dateOf: (t) => t.date, idOf: (t) => t.id }) : null;
    let ticketRow;
    if (ticketHit) {
      const t = ticketHit.record;
      ticketRow = push('ticket', {
        record_id: t.id, parent: inc.id, record_class: BENTLEY_CLASS.TICKETS, link_method: 'inferred_same_asset',
        link_detail: `same asset, ticket ${ticketHit.days} d after`, date: t.date, assetId: t.assetId,
        summary: t.summary, status: t.status, priority: t.priority,
      });
    } else {
      ticketRow = push('ticket', {
        record_id: `TIC-SYN-${n}`, parent: inc.id, link_method: 'synthetic',
        link_detail: !inc.assetId ? 'incident names no damaged asset' : !Number.isFinite(inc.date) ? 'incident date unknown'
          : `no ticket on asset ${inc.assetId} within ${LINK_WINDOW_DAYS} d`,
        date: later(inc.date, (1 + (h % 6)) * HOUR),
        summary: `${subtype.label} - ${subtype.issueCategory} (${inc.id})`, status: 'Closed', priority,
      });
    }
    const ticketId = ticketRow.record_id;

    const realTasks = ticketHit ? (tasksByTicket.get(ticketId) ?? []) : [];
    const taskRows = [];
    if (realTasks.length) {
      for (const t of realTasks) {
        taskRows.push(push('task', {
          record_id: t.id, parent: ticketId, record_class: BENTLEY_CLASS.TASKS, link_method: 'bentley_link',
          link_detail: `Related Ticket ID = ${ticketId}`, date: t.date, assetId: t.assetId,
          summary: t.summary, status: t.status, team: t.team, workType: t.type,
        }));
      }
    } else {
      const first = later(lastDate, (2 + ((h >>> 4) % 10)) * HOUR);
      taskTemplates.forEach((template, i) => {
        taskRows.push(push('task', {
          record_id: `TSK-SYN-${n}-${String(i + 1).padStart(2, '0')}`, parent: ticketId, link_method: 'synthetic',
          link_detail: ticketHit ? `no Bentley task names ticket ${ticketId}` : 'task of a synthetic ticket',
          date: later(first, [0, 4 * HOUR, 30 * HOUR][i] ?? i * DAY),
          summary: `${template.type} for ${inc.id}`, status: 'Completed', priority: ticketRow.priority, team: template.team, workType: template.type,
        }));
      });
    }
    const taskIds = new Set(taskRows.map((r) => r.record_id));

    const realWos = ticketHit
      ? [...new Map([...(wosByTicket.get(ticketId) ?? []), ...realTasks.flatMap((t) => wosByTask.get(t.id) ?? [])].map((w) => [w.id, w])).values()]
      : [];
    const wo = earliest(realWos);
    let woRow;
    let woDate = wo?.date ?? null;
    if (wo) {
      const viaTask = wo.taskId && taskIds.has(wo.taskId);
      woRow = push('work_order', {
        record_id: wo.id, parent: viaTask ? wo.taskId : ticketId, record_class: BENTLEY_CLASS.WORK_ORDERS, link_method: 'bentley_link',
        link_detail: viaTask ? `Related Task ID = ${wo.taskId}` : `Related Ticket ID = ${ticketId}`, date: wo.date, assetId: wo.assetId,
        summary: wo.summary, status: wo.status, priority: wo.priority, workType: wo.type,
      });
    } else {
      woDate = later(lastDate, (1 + ((h >>> 8) % 3)) * DAY);
      woRow = push('work_order', {
        record_id: `WO-SYN-${n}`, parent: taskRows[0]?.record_id ?? ticketId, link_method: 'synthetic',
        link_detail: ticketHit ? `no Bentley work order names ticket ${ticketId} or its tasks` : 'work order of a synthetic ticket',
        date: woDate,
        summary: `${subtype.label} response - ${subtype.repairCategory} (${inc.id})`, status: 'Completed', priority: ticketRow.priority,
        team: taskTemplates[1]?.team ?? taskTemplates[0]?.team, workType: inc.assetId ? 'Corrective Repair' : 'Field Restoration',
      });
    }

    const inspectionAsset = (wo?.assetId ?? inc.assetId) || null;
    const inspHit = inspectionAsset && Number.isFinite(woDate)
      ? pickFollowing(inspectionsByAsset.get(inspectionAsset), woDate, { dateOf: (i) => i.date, idOf: (i) => i.id }) : null;
    if (inspHit) {
      const i = inspHit.record;
      push('inspection', {
        record_id: i.id, parent: woRow.record_id, record_class: i.className, link_method: 'inferred_same_asset',
        link_detail: `same asset, inspection ${inspHit.days} d after`, date: i.date, assetId: i.assetId,
        summary: i.summary, result: i.result, condition: i.condition,
      });
    } else {
      const inspector = config.inspectors[(h >>> 12) % config.inspectors.length];
      push('inspection', {
        record_id: `INSP-SYN-${n}`, parent: woRow.record_id, link_method: 'synthetic',
        link_detail: inspectionAsset ? `no inspection on asset ${inspectionAsset} within ${LINK_WINDOW_DAYS} d of the work order`
          : 'no asset to match an inspection',
        date: later(lastDate, (5 + ((h >>> 16) % 10)) * DAY),
        summary: `Post-repair inspection by ${inspector} (${inc.id})`, status: 'Completed', team: inspector,
        result: 'Pass', condition: 'Good',
      });
    }
  }
  return { rows };
}

export function chainStats(rows) {
  const byStep = Object.fromEntries(CHAIN_STEPS.map((s) => [s, Object.fromEntries(LINK_METHODS.map((m) => [m, 0]))]));
  const chains = new Set();
  for (const row of rows) {
    chains.add(row.chain_id);
    byStep[row.step][row.link_method] += 1;
  }
  return { chains: chains.size, rows: rows.length, byStep };
}
