/**
 * What an FL511 live event says, in the shape the incident panel renders.
 *
 * Live Ops and Maintenance describe two different things that an operator reads the same way: an
 * event on the corridor right now, and a crash recorded last spring. This module states a live
 * event in the vocabulary the incident panel already speaks — a family colour, a severity, two or
 * three headline numbers, a sentence, and the source's own rows — so the two workspaces share one
 * panel rather than each growing their own.
 *
 * The difference that matters is kept: a live event is FL511's words, not ours. Nothing here
 * estimates a delay, a duration or a vehicle count, because the feed does not publish them; where
 * this module's own geometry contributed something (the nearest facility, the carriageway) it is
 * labelled as ours rather than mixed into the source's rows.
 *
 * Pure: event in, plain data out.
 */

import { LIVE_EVENT_LABELS, liveEventAssociationRows, liveEventLabel, liveEventSourceRows } from '../liveEventsData.js';
import { OPS_ICONS } from '../liveOps/opsIcons.js';
import { incidentVisual } from './incidentTypes.js';
import { carriagewayLabel } from './incidentContext.js';

/** The explorer's asset types this module speaks for — the five operational layers. */
export const LIVE_EVENT_ASSET_TYPES = Object.freeze(['incident', 'closure', 'construction', 'congestion', 'disabledVehicle']);
const LIVE_EVENT_ASSET_TYPE_SET = new Set(LIVE_EVENT_ASSET_TYPES);
export const isLiveEventAssetType = assetType => LIVE_EVENT_ASSET_TYPE_SET.has(assetType);

/** The Live Ops icon key behind each event type, so panel and map agree on the colour. */
const OPS_ICON_FOR_TYPE = Object.freeze({
  INCIDENT: 'incidents', CLOSURE: 'closures', CONSTRUCTION: 'construction',
  CONGESTION: 'congestion', DISABLED: 'disabledVehicles',
});

const text = value => {
  const string = value == null ? '' : String(value).trim();
  return string && string.toUpperCase() !== 'N/A' ? string : null;
};
const number = value => (value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));

/**
 * The colour and family for one live event.
 *
 * An FL511 incident carries its own crash type in its title ("Vehicle fire", "Multi-vehicle
 * crash"), so it is read with the same taxonomy the maintenance incidents use — one fire looks like
 * every other fire on this map. The other four types ARE their category, and take Live Ops' own
 * colour so the panel matches the pin the operator just clicked.
 *
 * @returns {{key: string, color: string, label: string}}
 */
export function liveEventVisual(event) {
  const ops = OPS_ICONS[OPS_ICON_FOR_TYPE[event?.type]] ?? null;
  if (event?.type === 'INCIDENT') {
    const crash = incidentVisual(event.title);
    if (crash.key !== 'other') return { key: crash.key, color: crash.color, label: crash.label };
  }
  return { key: OPS_ICON_FOR_TYPE[event?.type] ?? 'other', color: ops?.color ?? '#64748B', label: ops?.label ?? 'Live event' };
}

/**
 * How severe the event reads. FL511's own `severity` where it published one; otherwise what the
 * event is doing to the road. Never inferred from the type — a closure is not automatically "High".
 *
 * @returns {{level: string, label: string, tone: 'danger'|'warning'|'muted'}}
 */
export function liveEventSeverity(event) {
  const severity = text(event?.severity);
  if (severity) {
    const tone = /major|severe|high/i.test(severity) ? 'danger' : /minor|low/i.test(severity) ? 'muted' : 'warning';
    return { level: severity, label: severity, tone };
  }
  const lanes = text(event?.lanesBlocked) ?? text(event?.liveOps?.laneImpactLabel);
  if (lanes) return { level: 'Impacting', label: lanes, tone: 'warning' };
  const status = text(event?.status);
  return { level: status ?? 'Reported', label: status ?? 'Reported by FL511', tone: 'muted' };
}

/** The event's own columns, read once so the panel does not reach into the record five times. */
export function liveEventFacts(event) {
  return {
    type: liveEventLabel(event),
    category: LIVE_EVENT_LABELS[event?.type] ?? 'Live event',
    description: text(event?.description),
    roadway: text(event?.roadway),
    direction: text(event?.direction),
    severity: text(event?.severity),
    status: text(event?.status),
    lanesBlocked: text(event?.lanesBlocked),
    laneImpact: text(event?.liveOps?.laneImpactLabel),
    startTime: text(event?.startTime),
    endTime: text(event?.endTime),
    lastUpdated: text(event?.lastUpdated),
    detour: text(event?.detour),
    comment: text(event?.comment),
    region: text(event?.region),
    sourceId: text(event?.rawSourceId),
    source: text(event?.source) ?? 'FL511',
    nearestFacility: text(event?.nearestFacilityLabel),
    facilityDistanceM: number(event?.distanceToNearestFacilityM),
    carriageway: text(event?.liveOps?.carriagewayLabel),
    section: text(event?.liveOps?.sectionLabel),
  };
}

/** When the event was reported, as one line: FL511's start time, or its last update. */
export const liveEventReportedAt = facts => facts.startTime ?? facts.lastUpdated ?? null;

/**
 * The headline tiles. Only what the feed answers — an event with no lane impact and no severity
 * shows one tile or none, rather than a row of dashes.
 *
 * @returns {{value: string, label: string, tone: 'danger'|'warning'|'muted'}[]}
 */
export function liveEventHeadline(facts) {
  const cards = [];
  const lanes = facts.lanesBlocked ?? facts.laneImpact;
  if (lanes) cards.push({ value: lanes, label: 'Lane impact', tone: 'warning' });
  if (facts.severity) cards.push({ value: facts.severity, label: 'Severity', tone: /major|severe|high/i.test(facts.severity) ? 'danger' : 'warning' });
  if (facts.status) cards.push({ value: facts.status, label: 'Status', tone: 'muted' });
  return cards.slice(0, 3);
}

/**
 * The event in prose. FL511's description leads where it published one, because those are the words
 * the operator will hear on the radio; everything after it is stated as measurement or inference.
 *
 * @returns {string[]}
 */
export function liveEventNarrative(event, place = null) {
  const facts = liveEventFacts(event);
  const sentences = [];
  const where = facts.carriageway ? [facts.carriageway, facts.section].filter(Boolean).join(' · ')
    : place?.resolved ? carriagewayLabel(place)
      : facts.roadway ?? facts.nearestFacility ?? 'the I-595 corridor';
  sentences.push(`${facts.category} on ${where}${liveEventReportedAt(facts) ? `, reported ${liveEventReportedAt(facts)}` : ''}.`);
  if (facts.description) sentences.push(facts.description);
  const lanes = facts.lanesBlocked ?? facts.laneImpact;
  sentences.push(lanes ? `Lane impact: ${lanes}.` : 'FL511 reports no lane impact for this event.');
  if (facts.detour) sentences.push(`Detour: ${facts.detour}.`);
  if (facts.endTime) sentences.push(`Expected to clear ${facts.endTime}.`);
  // Said plainly rather than left to be assumed from a blank panel.
  sentences.push('FL511 does not publish a delay or a queue length for live events, so none is shown.');
  return sentences;
}

/** The Impact tab's rows: what the event is doing to the road, and where we place it. */
export function liveEventImpactRows(event, place = null) {
  const facts = liveEventFacts(event);
  return [
    ['Lanes blocked', facts.lanesBlocked],
    ['Lane impact', facts.laneImpact],
    ['Severity', facts.severity],
    ['Status', facts.status],
    ['Carriageway', facts.carriageway ?? (place?.resolved ? carriagewayLabel(place) : null)],
    ['Section', facts.section],
    ['Started', facts.startTime],
    ['Ends', facts.endTime],
    ['Detour', facts.detour],
  ].filter(([, value]) => value != null);
}

/**
 * The Details tab: FL511's own rows first, then the rows our geometry derived, under a heading that
 * says so. Proximity to a facility is not a claim that FL511 placed the event on it.
 *
 * @returns {{heading: string|null, rows: [string, string][]}[]}
 */
export function liveEventDetailSections(event) {
  const association = liveEventAssociationRows(event);
  return [
    { heading: null, rows: liveEventSourceRows(event), note: null },
    ...(association.length ? [{
      heading: 'Matched by this application',
      rows: association,
      // Said in the panel, not just in a comment: corridor closures routinely sit metres from an
      // I-595 ramp while belonging to a different road, and an operator dispatching on "nearest
      // facility" needs to know that is our measurement rather than FL511's attribution.
      note: 'Proximity does not mean FL511 placed the event on that facility.',
    }] : []),
  ];
}
