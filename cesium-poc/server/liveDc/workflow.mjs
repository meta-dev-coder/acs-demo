/**
 * Incident workflow engine: derives Live Tickets -> Tasks -> Work Order -> Inspection -> Asset Status
 * from Live Events records. Pure and deterministic: every timestamp comes from milestones computed
 * from the event's own first_seen_at / cleared_at, never from `now`, so reruns are byte-identical and
 * the cycle's diff sends nothing when nothing changed. `now` only decides which milestones are reached.
 */
import { readFileSync } from 'node:fs';
import { LIVE_CLASS, PROJECT_CODE, liveClassDefinition, completeRecord } from './classes.mjs';
import { nearestAsset } from './assetCatalog.mjs';
import { haversineMeters } from '../geo.mjs';

const CONFIG_URL = new URL('../../config/liveDc/workflow.json', import.meta.url);
const PROFILE_KEYS = Object.freeze(['assignAfterSeconds', 'workOrderAfterSeconds', 'inspectionAfterClearSeconds', 'closeAfterInspectionSeconds']);
const WORKFLOW_CLASSES = Object.freeze([LIVE_CLASS.TICKETS, LIVE_CLASS.TASKS, LIVE_CLASS.WORK_ORDERS, LIVE_CLASS.INSPECTIONS, LIVE_CLASS.ASSET_STATUS]);
const HIGH_SEVERITY = /major|severe|serious/i;

const iso = (ms) => new Date(ms).toISOString();

function validateProfiles(config) {
  if (!config.profiles || typeof config.profiles !== 'object') throw new Error('workflow config: profiles missing');
  for (const [name, profile] of Object.entries(config.profiles)) {
    for (const key of PROFILE_KEYS) {
      if (!(Number.isFinite(profile?.[key]) && profile[key] >= 0)) throw new Error(`workflow profile '${name}': ${key} must be a number >= 0`);
    }
    if (profile.workOrderAfterSeconds < profile.assignAfterSeconds) {
      throw new Error(`workflow profile '${name}': workOrderAfterSeconds must be >= assignAfterSeconds`);
    }
  }
  if (!config.profiles[config.defaultProfile]) throw new Error(`workflow config: unknown profile '${config.defaultProfile}'`);
}

export function loadWorkflowConfig(overrides = {}) {
  const config = { ...JSON.parse(readFileSync(CONFIG_URL, 'utf8')), ...overrides };
  validateProfiles(config);
  return config;
}

const SELF_CLASSIFYING_TYPES = new Set(['INCIDENT', 'DISABLED']);

/**
 * The existing ticket's subtype is sticky once the inspection has used it, or when the event's type
 * changed to one that cannot classify itself (INCIDENT -> CLOSURE). Before that the current event
 * decides, so a subtype guessed from a detail-less first poll is corrected when details arrive.
 */
export function classifySubtype(eventRecord, config, { existingTicket = null, existingInspection = null } = {}) {
  const byId = new Map(config.subtypes.map((s) => [s.id, s]));
  const sticky = existingTicket?.incident_subtype;
  const locked = existingInspection || !SELF_CLASSIFYING_TYPES.has(eventRecord.event_type);
  if (sticky && byId.has(sticky) && locked) return byId.get(sticky);
  if (eventRecord.event_type === 'DISABLED') return byId.get('disabled');
  if (eventRecord.event_type !== 'INCIDENT') return byId.get('no_damage');
  const text = `${eventRecord.name ?? ''} ${eventRecord.title ?? ''} ${eventRecord.description ?? ''}`.toLowerCase();
  const match = config.subtypes.find((s) => s.keywords?.length
    && (!s.facility || s.facility === eventRecord.carriageway)
    && s.keywords.some((k) => text.includes(k.toLowerCase())));
  return match ?? byId.get(eventRecord.carriageway === 'EXPRESS' ? 'crash_express' : 'crash');
}

/** Returns null when first_seen_at is unparsable (the event cannot anchor a chain). */
export function milestonesFor(eventRecord, { profile, existingInspection = null }) {
  const t0 = Date.parse(eventRecord.first_seen_at);
  if (!Number.isFinite(t0)) return null;
  const assign = t0 + profile.assignAfterSeconds * 1000;
  const workOrder = t0 + profile.workOrderAfterSeconds * 1000;
  const clearedAt = eventRecord.status === 'cleared' && eventRecord.cleared_at ? Date.parse(eventRecord.cleared_at) : NaN;
  const recorded = existingInspection?.inspected_at ? Date.parse(existingInspection.inspected_at) : NaN;
  const afterClear = profile.inspectionAfterClearSeconds * 1000;
  let cleared = Number.isFinite(clearedAt) ? Math.max(clearedAt, workOrder) : null;
  // A recorded inspection means the event did clear; if it reappeared since, the clearing that led to
  // the inspection stays in the past so tasks completed on it are not reopened under a closed ticket.
  if (cleared === null && Number.isFinite(recorded)) cleared = Math.min(recorded, Math.max(workOrder, recorded - afterClear));
  const inspection = Number.isFinite(recorded) ? recorded : (cleared !== null ? cleared + afterClear : null);
  const close = inspection !== null ? inspection + profile.closeAfterInspectionSeconds * 1000 : null;
  return { t0, assign, workOrder, cleared, inspection, close };
}

const formatters = new Map();
function partsFor(ms, timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }));
  }
  return Object.fromEntries(formatters.get(timeZone).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
}

export function formatDcDate(ms, timeZone) {
  const p = partsFor(ms, timeZone);
  return `${p.day}/${p.month}/${p.year}`;
}

export function formatDcTime(ms, timeZone) {
  const p = partsFor(ms, timeZone);
  return `${p.hour}:${p.minute}`;
}

function fnv1a32(value) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(String(value))) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

const reached = (milestone, now) => milestone !== null && milestone !== undefined && now >= milestone;

/** Walks [milestone, status] steps in logical order; returns the current status and when it last changed. */
function statusAt(steps, now) {
  let status = null, changedAt = null;
  for (const [milestone, next] of steps) {
    if (!reached(milestone, now)) continue;
    if (next !== status) { status = next; changedAt = milestone; }
  }
  return { status, changedAt };
}

function finite(value) {
  if (typeof value === 'string' && value.trim() !== '') value = Number(value);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function position(longitude, latitude) {
  const lon = finite(longitude), lat = finite(latitude);
  if (lon === null || lat === null) return {};
  return { x_coordinates: lon, y_coordinates: lat, geometry: { type: 'Point', coordinates: [lon, lat] } };
}

function taskListFor(event, subtype, config, existingTaskCount) {
  const base = subtype.id === 'disabled' ? config.tasks.DISABLED : (config.tasks[event.event_type] ?? config.tasks.default);
  if (!existingTaskCount || base.length === existingTaskCount) return base;
  // A sticky chain keeps the task list it was created with, even if the event's type changed since.
  return Object.values(config.tasks).find((list) => list.length === existingTaskCount) ?? base;
}

function damageFor(event, eventPos, subtype, existingInspection, assets, config) {
  if (existingInspection) {
    const code = existingInspection.asset_id ? String(existingInspection.asset_id) : '';
    if (existingInspection.pass_fail !== 'Fail' || !code) return null;
    const known = assets.find((a) => a.code === code);
    const asset = known ?? {
      code,
      category: existingInspection.asset_type ?? '',
      systemClass: existingInspection['system class'] ?? null,
      longitude: finite(existingInspection.x_coordinates),
      latitude: finite(existingInspection.y_coordinates),
    };
    let distanceM = finite(existingInspection.distance_to_event_m);
    if (distanceM === null && eventPos.x_coordinates !== undefined && finite(asset.longitude) !== null && finite(asset.latitude) !== null) {
      distanceM = Math.round(haversineMeters(eventPos.x_coordinates, eventPos.y_coordinates, asset.longitude, asset.latitude) * 10) / 10;
    }
    return { asset, distanceM };
  }
  if (!subtype.categories?.length || fnv1a32(event.keyInSource) / 2 ** 32 >= config.damage.rate) return null;
  if (eventPos.x_coordinates === undefined) return null;
  return nearestAsset(assets, { longitude: eventPos.x_coordinates, latitude: eventPos.y_coordinates },
    { categories: subtype.categories, radiusMeters: config.damage.radiusMeters });
}

function indexByKey(records) {
  const map = new Map();
  for (const record of records ?? []) if (record?.keyInSource) map.set(record.keyInSource, record);
  return map;
}

export function runWorkflow({ events, existing = {}, assets = [], now, config, profileName = config.defaultProfile, linkMode = 'live' }) {
  const profile = config.profiles?.[profileName];
  if (!profile) throw new Error(`workflow: unknown profile '${profileName}'`);
  const defs = Object.fromEntries(WORKFLOW_CLASSES.map((cls) => [cls, liveClassDefinition(cls, { linkMode })]));
  const emit = (cls, record) => completeRecord(defs[cls], record);
  const date = (ms) => formatDcDate(ms, config.timeZone);
  const time = (ms) => formatDcTime(ms, config.timeZone);

  const existingTickets = indexByKey(existing[LIVE_CLASS.TICKETS]);
  const existingInspections = indexByKey(existing[LIVE_CLASS.INSPECTIONS]);
  const taskCounts = new Map();
  for (const taskKey of indexByKey(existing[LIVE_CLASS.TASKS]).keys()) {
    const chainKey = taskKey.replace(/^TSK-/, '').replace(/-\d+$/, '');
    taskCounts.set(chainKey, (taskCounts.get(chainKey) ?? 0) + 1);
  }

  const out = Object.fromEntries(WORKFLOW_CLASSES.map((cls) => [cls, []]));
  const damagedAssets = new Map();
  const stats = { chains: 0, tickets: 0, tasks: 0, workOrders: 0, inspections: 0, damaged: 0, passed: 0 };

  for (const event of events ?? []) {
    const key = event?.keyInSource;
    if (!key) continue;
    const itemId = key.replace(/^FL511-/, '');
    const ticketKey = `TIC-${key}`, woKey = `WO-${key}`, inspKey = `INSP-${key}`;
    const existingTicket = existingTickets.get(ticketKey) ?? null;
    if (!config.spawnTypes.includes(event.event_type) && !existingTicket) continue;
    const existingInspection = existingInspections.get(inspKey) ?? null;
    const ms = milestonesFor(event, { profile, existingInspection });
    if (!ms) continue;

    stats.chains++;
    const subtype = classifySubtype(event, config, { existingTicket, existingInspection });
    const eventPos = position(event.longitude ?? event.x_coordinates, event.latitude ?? event.y_coordinates);
    const eventName = event.name || key;
    const eventDescription = event.description || eventName;
    const segment = event.section_label || event.nearest_facility_label || '';
    const priority = HIGH_SEVERITY.test(event.severity ?? '') || event.full_closure === 'Yes' ? 'High'
      : (event.event_type === 'DISABLED' ? 'Low' : 'Medium');
    const common = {
      source_event_id: key,
      project: PROJECT_CODE,
      'segment ID': event['segment ID'] ?? '',
      'segment name': event['segment name'] ?? '',
      ...eventPos,
    };
    const xy = { 'X Coordinate': eventPos.x_coordinates, 'Y Coordinate': eventPos.y_coordinates };

    const inspected = reached(ms.inspection, now);
    const damage = inspected ? damageFor(event, eventPos, subtype, existingInspection, assets, config) : null;
    const failed = inspected && damage !== null;
    const assetFields = failed
      ? { 'Asset ID': damage.asset.code, 'Asset Type': damage.asset.category ?? '', 'System Class': damage.asset.systemClass ?? '' }
      : { 'Asset ID': '', 'Asset Type': '', 'System Class': '' };

    const afterInspection = failed ? [[ms.inspection, 'In Progress']]
      : [[ms.inspection, 'Resolved'], [ms.close, 'Closed']];
    const ticketStatus = statusAt([[ms.t0, 'Open'], [ms.assign, 'Assigned'], [ms.workOrder, 'In Progress'], ...afterInspection], now);
    out[LIVE_CLASS.TICKETS].push(emit(LIVE_CLASS.TICKETS, {
      keyInSource: ticketKey, code: ticketKey, name: subtype.label, description: eventDescription,
      'Ticket ID': ticketKey,
      'Issue Summary': `${subtype.label} - ${eventName}`,
      'Issue Category': subtype.issueCategory,
      'Ticket Status': ticketStatus.status ?? 'Open',
      Priority: priority,
      ...assetFields,
      Segment: segment,
      'Ticket Opened Date': date(ms.t0),
      'Ticket Opened Time': time(ms.t0),
      'Detailed Notes': eventDescription,
      'Source Signal': config.sourceSignal,
      ...xy,
      incident_subtype: subtype.id,
      ...common,
      created_at: iso(ms.t0),
      status_changed_at: iso(ticketStatus.changedAt ?? ms.t0),
    }));
    stats.tickets++;

    const taskList = taskListFor(event, subtype, config, taskCounts.get(key) ?? 0);
    for (const task of taskList) {
      const taskKey = `TSK-${key}-${String(task.seq).padStart(2, '0')}`;
      const taskStatus = statusAt([[ms.t0, 'Open'], [ms[task.start], 'In Progress'], [ms[task.complete], 'Completed']], now);
      out[LIVE_CLASS.TASKS].push(emit(LIVE_CLASS.TASKS, {
        keyInSource: taskKey, code: taskKey, name: task.type,
        description: `${task.type} for ${eventName} (${key})`,
        'Task ID': taskKey,
        'Task Type': task.type,
        'Task Status': taskStatus.status ?? 'Open',
        'Related Ticket ID': ticketKey,
        'Assigned Team': task.team,
        'Task Date': date(ms.t0),
        'Task Notes': `${task.type} for ${eventName} (${key})`,
        ...assetFields,
        Segment: segment,
        ...xy,
        task_seq: task.seq,
        ...common,
        created_at: iso(ms.t0),
        status_changed_at: iso(taskStatus.changedAt ?? ms.t0),
      }));
      stats.tasks++;
    }

    if (!reached(ms.workOrder, now)) continue;
    const workType = failed ? 'Corrective Repair' : 'Field Restoration';
    const woStatus = statusAt([[ms.workOrder, 'Open'], [ms.cleared, 'In Progress'],
      [ms.inspection, failed ? 'In Progress' : 'Completed']], now);
    out[LIVE_CLASS.WORK_ORDERS].push(emit(LIVE_CLASS.WORK_ORDERS, {
      keyInSource: woKey, code: woKey, name: workType,
      description: `${subtype.label} response - ${eventName}`,
      'Work Order ID': woKey,
      'Work Type': workType,
      'Work Order Status': woStatus.status,
      Priority: priority,
      ...assetFields,
      Segment: segment,
      'Work Order Open Date': date(ms.workOrder),
      'Close Date': inspected && !failed ? date(ms.inspection) : '',
      'Work Description': `${subtype.label} response - ${eventName}`,
      'Related Ticket ID': ticketKey,
      'Related Task ID': `TSK-${key}-01`,
      'Repair Category': subtype.repairCategory,
      ...common,
      created_at: iso(ms.workOrder),
      status_changed_at: iso(woStatus.changedAt),
    }));
    stats.workOrders++;

    if (!inspected) continue;
    const label = subtype.label.toLowerCase();
    const asset = damage?.asset;
    const assetPos = failed ? position(asset.longitude, asset.latitude) : {};
    const inspPos = failed && assetPos.x_coordinates !== undefined ? assetPos : eventPos;
    const issueSummary = failed
      ? `${asset.category} ${asset.code} damaged after ${label} (${key})`
      : `No asset damage found after ${label} (${key})`;
    const result = failed ? 'Fail' : 'Pass';
    out[LIVE_CLASS.INSPECTIONS].push(emit(LIVE_CLASS.INSPECTIONS, {
      keyInSource: inspKey, code: inspKey, name: `Post-incident inspection ${itemId}`, description: issueSummary,
      record_id: inspKey,
      inspection_form_family: config.inspectionFormFamily,
      inspection_date: date(ms.inspection),
      inspection_time: time(ms.inspection),
      inspected_at: iso(ms.inspection),
      inspector_name: config.inspectors[fnv1a32(inspKey) % config.inspectors.length],
      asset_id: failed ? asset.code : '',
      asset_type: failed ? (asset.category ?? '') : '',
      'system class': failed ? (asset.systemClass ?? '') : '',
      pass_fail: result,
      inspection_result: result,
      asset_condition: failed ? 'Poor' : 'Good',
      observed_condition: failed ? 'Impact-related damage observed' : 'Good',
      recommended_action: failed ? 'Schedule WO to repair' : 'Schedule next inspection',
      risk_rating_1_5: failed ? 4 : 1,
      issue_summary: issueSummary,
      related_ticket_id: ticketKey,
      related_work_order_id: woKey,
      distance_to_event_m: failed ? (damage.distanceM ?? undefined) : undefined,
      segment,
      ...common,
      ...inspPos,
      created_at: iso(ms.inspection),
      status_changed_at: iso(ms.inspection),
    }));
    stats.inspections++;
    if (!failed) { stats.passed++; continue; }
    stats.damaged++;

    const statusKey = `AST-${asset.code}`;
    const candidate = { at: ms.inspection, eventKey: key, record: {
      keyInSource: statusKey, code: statusKey, name: `${asset.category} ${asset.code}`, description: `Damaged: ${issueSummary}`,
      asset_id: asset.code,
      asset_category: asset.category ?? '',
      'system class': asset.systemClass ?? '',
      status: 'Damaged',
      damaged_at: iso(ms.inspection),
      source_inspection_id: inspKey,
      source_event_id: key,
      project: PROJECT_CODE,
      ...inspPos,
      created_at: iso(ms.inspection),
    } };
    const current = damagedAssets.get(statusKey);
    if (!current || candidate.at > current.at || (candidate.at === current.at && candidate.eventKey > current.eventKey)) {
      damagedAssets.set(statusKey, candidate);
    }
  }

  for (const { record } of damagedAssets.values()) out[LIVE_CLASS.ASSET_STATUS].push(emit(LIVE_CLASS.ASSET_STATUS, record));
  for (const cls of WORKFLOW_CLASSES) {
    out[cls].sort((a, b) => (a.keyInSource < b.keyInSource ? -1 : a.keyInSource > b.keyInSource ? 1 : 0));
  }
  return { byClass: out, stats };
}
