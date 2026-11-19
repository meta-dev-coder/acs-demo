#!/usr/bin/env node
/**
 * Build the November 2026 cruise datasets from the original Dock Report and the vessel research.
 *
 *   node tools/build-cruise-data.mjs            (npm run data:cruise)
 *
 * Inputs (never modified):
 *   data/cruise/source/portmiami_november_2026_dock_enriched_all.json   the 149 Dock Report calls
 *   data/cruise/vessel-research/*.json                                  one research record per ship
 *
 * Outputs (public/data/cruise/, read by the app):
 *   portmiami_vessel_master.json              one record per ship: IMO, names, operator, capacity, source
 *   portmiami_november_2026_enriched.json     all 149 calls, capacity joined from the master
 *   portmiami_november_2026_simulation.json   only the calls with a validated capacity
 *   portmiami_capacity_coverage_report.json   coverage by call, vessel and date; before and after
 *
 * The Dock Report's dates, times, terminals, berth movements and source fields are copied as they
 * are. The build stops, writing nothing, if the master has a duplicate IMO or name, a capacity
 * without a source, or if any call is lost or duplicated.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPACITY_STATUS, coverageReport, enrichCalls, normalizeVesselName, validateVesselMaster,
} from '../src/cruise/vesselMaster.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'data/cruise/source/portmiami_november_2026_dock_enriched_all.json');
const RESEARCH = join(ROOT, 'data/cruise/vessel-research');
const OUT = join(ROOT, 'public/data/cruise');
const BUILT = '2026-11-19';

const fail = message => { console.error(`build-cruise-data: ${message}`); process.exit(1); };
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const slug = name => normalizeVesselName(name).replace(/ /g, '-');

// ---- the master, from the research records ---------------------------------------------------------
const REVIEW = join(ROOT, 'data/cruise/vessel-review.json');
const raw = readdirSync(RESEARCH).filter(f => f.endsWith('.json')).sort().flatMap(f => read(join(RESEARCH, f)));
// Reviewer decisions are applied on top of the research records, each with its reason, so the
// research stays as found and every change to it is visible in one file.
const review = read(REVIEW).decisions ?? [];
for (const d of review) {
  if (!raw.some(r => r.dock_report_name === d.dock_report_name)) fail(`review decision for unknown ship "${d.dock_report_name}"`);
  if (!d.reason) fail(`review decision for "${d.dock_report_name}" has no reason`);
}
const research = raw.map(r => {
  const decisions = review.filter(d => d.dock_report_name === r.dock_report_name);
  return decisions.reduce((acc, d) => ({ ...acc, ...d.set, review: [...(acc.review ?? []), { set: d.set, reason: d.reason, decided_on: d.decided_on ?? BUILT }] }), r);
});
const master = research.map(r => ({
  vessel_id: r.imo ? `imo-${r.imo}` : `name-${slug(r.canonical_name || r.dock_report_name)}`,
  imo: r.imo ?? null,
  imo_source_url: r.imo_source_url ?? null,
  canonical_name: r.canonical_name || r.dock_report_name,
  aliases: [...new Set([r.dock_report_name, ...(r.aliases ?? [])].filter(n => n && normalizeVesselName(n) !== normalizeVesselName(r.canonical_name)))],
  operator: r.operator ?? null,
  passenger_capacity: Number(r.passenger_capacity) > 0 ? Number(r.passenger_capacity) : null,
  capacity_type: r.capacity_type ?? null,
  capacity_definition: {
    double_occupancy: 'Guests at double occupancy (two per cabin) — the same basis as lower berths.',
    lower_berth: 'Lower berths: two per cabin, excluding upper berths — the same basis as double occupancy.',
    maximum: 'Maximum passengers including upper berths. Not comparable with double occupancy.',
    unspecified: 'The source does not state which definition its figure uses.',
  }[r.capacity_type] ?? null,
  capacity_source_url: r.capacity_source_url ?? null,
  capacity_source_title: r.capacity_source_title ?? null,
  capacity_source_kind: r.capacity_source_kind ?? null,
  source_date: r.source_date ?? null,
  verified_on: r.verified_on ?? null,
  quote: r.quote ?? null,
  other_values_seen: r.other_values_seen ?? [],
  status: r.status,
  notes: r.notes ?? '',
  review: r.review ?? [],
})).sort((a, b) => a.canonical_name.localeCompare(b.canonical_name));

const problems = validateVesselMaster(master);
if (problems.length) fail(`the vessel master is not consistent:\n  ${problems.join('\n  ')}`);

// ---- the join -------------------------------------------------------------------------------------------
const source = read(SOURCE);
const original = source.cruise_calls;
const enriched = enrichCalls(original, master);

// Nothing lost, nothing duplicated, nothing of the Dock Report changed.
if (enriched.length !== original.length) fail(`${original.length} calls in, ${enriched.length} out`);
if (new Set(enriched.map(c => c.id)).size !== enriched.length) fail('duplicate call ids');
const PRESERVED = ['id', 'dock_request_number', 'ship_name', 'arrival_date', 'arrival_time_local', 'departure_date', 'departure_time_local',
  'arrival_datetime_local', 'departure_datetime_local', 'terminal_code', 'berth_movements', 'source_pdf_page', 'voyage_options',
  'itinerary_match_status', 'scheduled_terminal_code', 'terminal_assignment_source', 'timezone', 'notes', 'reported_port_stay_minutes', 'actual_passengers'];
enriched.forEach((c, i) => {
  for (const k of PRESERVED) {
    if (JSON.stringify(c[k]) !== JSON.stringify(original[i][k])) fail(`call ${original[i].id}: field ${k} changed`);
  }
});

const unmatched = [...new Set(enriched.filter(c => !c.vessel_id).map(c => c.ship_name))];
const simulation = enriched.filter(c => c.capacity_status === CAPACITY_STATUS.VALIDATED);

// ---- coverage, before and after -----------------------------------------------------------------------
const after = coverageReport(enriched);
const beforeCalls = original.filter(c => Number(c.passenger_capacity) > 0);
const nov22 = list => list.filter(c => c.arrival_date === '2026-11-22' || c.departure_date === '2026-11-22');
const report = {
  generated: BUILT,
  inputs: { dock_report: 'data/cruise/source/portmiami_november_2026_dock_enriched_all.json', research_records: research.length },
  before: {
    capacity_source: source.metadata?.capacity_source ?? null,
    modelled_calls: beforeCalls.length,
    modelled_vessels: new Set(beforeCalls.map(c => normalizeVesselName(c.ship_name))).size,
    nov22: { calls: nov22(original).length, modelled: nov22(beforeCalls).length },
  },
  after: {
    ...after,
    nov22: { calls: nov22(enriched).length, modelled: nov22(simulation).length, modelled_ships: nov22(simulation).map(c => c.ship_name) },
  },
  unmatched_ship_names: unmatched,
  newly_enriched: master.filter(v => v.passenger_capacity && !beforeCalls.some(c => normalizeVesselName(c.ship_name) === normalizeVesselName(v.canonical_name)
      || (v.aliases ?? []).some(a => normalizeVesselName(a) === normalizeVesselName(c.ship_name))))
    .map(v => ({ ship: v.canonical_name, imo: v.imo, capacity: v.passenger_capacity, capacity_type: v.capacity_type, status: v.status, source: v.capacity_source_url ?? v.capacity_source_title })),
  review_queue: master.filter(v => v.status !== 'VERIFIED_OFFICIAL' || !['double_occupancy', 'lower_berth'].includes(v.capacity_type))
    .map(v => ({ ship: v.canonical_name, status: v.status, capacity: v.passenger_capacity, capacity_type: v.capacity_type, notes: v.notes })),
};

// ---- write ------------------------------------------------------------------------------------------------
const metadata = {
  ...source.metadata,
  capacity_source: 'portmiami_vessel_master.json (one record per ship; see each call\'s passenger_capacity_source)',
  previous_capacity_source: source.metadata?.capacity_source ?? null,
  capacity_verified_records: simulation.length,
  built: BUILT,
  data_notes: [
    ...(source.metadata?.data_notes ?? []).filter(n => !/Passenger capacity is missing/.test(n)),
    'passenger_capacity is set only for calls whose capacity is validated (verified source, double-occupancy / lower-berth definition). published_capacity keeps any figure found, with capacity_type and capacity_status.',
    'Passenger capacity is a ship capacity, not a count of passengers on a sailing.',
  ],
};
const write = (name, data) => writeFileSync(join(OUT, name), `${JSON.stringify(data, null, 2)}\n`);
write('portmiami_vessel_master.json', { generated: BUILT, vessels: master });
write('portmiami_november_2026_enriched.json', { metadata, cruise_calls: enriched });
write('portmiami_november_2026_simulation.json', { metadata: { ...metadata, subset: 'Calls with a validated passenger capacity only.' }, cruise_calls: simulation });
write('portmiami_capacity_coverage_report.json', report);

console.log(`vessels ${master.length} · calls ${enriched.length} · modelled ${report.before.modelled_calls} → ${simulation.length} calls, ${report.before.modelled_vessels} → ${after.modelled_vessels} vessels · Nov 22 ${report.before.nov22.modelled} → ${report.after.nov22.modelled} of ${report.after.nov22.calls}`);
if (unmatched.length) console.log(`unmatched ship names: ${unmatched.join(', ')}`);
