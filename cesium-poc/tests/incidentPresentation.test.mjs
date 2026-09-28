/**
 * The incident taxonomy, and what is resolved from an incident's coordinates.
 *
 * Asserted against the committed corridor geometry rather than fixtures: the point of
 * `carriagewayAt` is that it agrees with the FDOT segments the map itself draws, and a hand-written
 * line would only prove the arithmetic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { INCIDENT_FAMILIES, incidentSeverity, incidentVisual } from '../src/assetExplorer/incidentTypes.js';
import {
  CARRIAGEWAY_LIMIT_M, camerasNear, carriagewayAt, carriagewayLabel, carriagewayLines, distanceLabel, projectOntoLine,
} from '../src/assetExplorer/incidentContext.js';
import { detailFacts, impactRows, incidentFacts, incidentHeadline, incidentNarrative, reportedAt } from '../src/assetExplorer/incidentNarrative.js';
import { normalizeIncident } from '../src/maintenance/maintenanceRecords.js';

const read = async name => JSON.parse(await readFile(fileURLToPath(new URL(`../public/${name}`, import.meta.url)), 'utf8'));
const segments = await read('data/i595_fdot_traffic_segments.geojson');
const express = await read('data/express-way.geojson');
const cameras = await read('data/i595_corridor_cameras.geojson');
const incidents = await read('dataconnect-data/incidents_v3.json');
const lines = [...carriagewayLines(segments), ...carriagewayLines(express)];

test('every incident type in the register is classified, not left as "other"', () => {
  const types = [...new Set(incidents.map(row => row.incident_type))];
  assert.ok(types.length >= 15, 'the register should carry the full taxonomy');
  const unclassified = types.filter(type => incidentVisual(type).key === 'other');
  assert.deepEqual(unclassified, [], `unclassified incident types: ${unclassified.join(', ')}`);
});

test('the families that share a pictogram do not share a colour', () => {
  const colors = INCIDENT_FAMILIES.map(family => family.color);
  assert.equal(new Set(colors).size, colors.length);
});

test('a type is matched by its words, so a spelling never seen before still lands in a family', () => {
  assert.equal(incidentVisual('Vehicle fire').key, 'fire');
  assert.equal(incidentVisual('Attenuator hit').key, 'attenuator');
  assert.equal(incidentVisual('Vehicle vs attenuator').key, 'attenuator', 'the more specific attenuator rule wins over "vs"');
  assert.equal(incidentVisual('Vehicle vs barrier').key, 'barrier');
  assert.equal(incidentVisual('Flooding-related spinout').key, 'flooding');
  assert.equal(incidentVisual('Wrong-way near miss escalated to crash').key, 'wrongWay');
  assert.equal(incidentVisual('Tanker rollover with fire').key, 'fire', 'the first matching rule wins');
  assert.equal(incidentVisual('').key, 'other');
  assert.equal(incidentVisual(null).key, 'other');
});

test('severity comes from harm and closure, never from the type', () => {
  const record = related => ({ related });
  assert.equal(incidentSeverity(record({ fatalities: 2 })).label, '2 fatalities');
  assert.equal(incidentSeverity(record({ injuries: 'Yes' })).level, 'High');
  assert.equal(incidentSeverity(record({ laneClosure: 'Yes' })).level, 'Moderate');
  assert.equal(incidentSeverity(record({})).level, 'Reported');
});

test('projectOntoLine measures the offset and how far along the line the nearest point lies', () => {
  const line = [[-80.3, 26.0], [-80.2, 26.0]];
  const hit = projectOntoLine(-80.25, 26.0, line);
  assert.ok(hit.offsetM < 1);
  assert.ok(Math.abs(hit.fraction - 0.5) < 0.01);
});

test('an incident on the corridor resolves to a carriageway, a milepost and its cross streets', () => {
  // The first record of the register — a barrier strike in the Central Segment.
  const record = normalizeIncident(incidents[0]);
  const place = carriagewayAt(record.longitude, record.latitude, lines);
  assert.ok(place.resolved, `expected a carriageway within ${CARRIAGEWAY_LIMIT_M} m, got ${place.offsetM?.toFixed(0)} m`);
  assert.ok(['EB', 'WB', 'REVERSIBLE'].includes(place.direction));
  assert.ok(place.milepost >= 0 && place.milepost <= 13, `milepost out of corridor: ${place.milepost}`);
  assert.match(carriagewayLabel(place), /I-595 (Eastbound|Westbound|Express)/);
});

test('most of the register resolves to a carriageway, and the rest says so rather than guessing', () => {
  // Half the register carries its own coordinates; the rest is positioned from its damaged asset,
  // which the workspace resolves and this test does not need to repeat.
  const placed = incidents.map(normalizeIncident).filter(item => Number.isFinite(item.longitude));
  assert.ok(placed.length > 80, `only ${placed.length} incidents carry their own coordinates`);
  const resolved = placed.filter(item => carriagewayAt(item.longitude, item.latitude, lines)?.resolved);
  assert.ok(resolved.length / placed.length > 0.8, `only ${resolved.length}/${placed.length} resolved`);
});

test('a point far from the corridor is reported unresolved, not matched to the nearest line anyway', () => {
  const place = carriagewayAt(-80.25, 26.5, lines);
  assert.equal(place.resolved, false);
  assert.equal(carriagewayLabel(place), 'Carriageway unresolved');
});

test('cameras come back nearest first, in range, and only the ones with a feed can be shown', () => {
  const record = normalizeIncident(incidents[0]);
  const near = camerasNear(record.longitude, record.latitude, cameras);
  assert.ok(near.length > 0);
  assert.deepEqual([...near].sort((a, b) => a.metres - b.metres).map(camera => camera.id), near.map(camera => camera.id));
  assert.ok(near.every(camera => camera.metres <= 1600));
  assert.ok(near.some(camera => camera.divasChannelId), 'the lead camera needs a snapshot channel to show a frame');
});

test('a camera beyond the range is dropped rather than offered as "nearby"', () => {
  assert.deepEqual(camerasNear(-80.25, 26.9, cameras), []);
});

test('distances read in metres up close and miles once they stop being "just there"', () => {
  assert.equal(distanceLabel(120), '120 m away');
  assert.equal(distanceLabel(3218.7), '2.0 mi away');
  assert.equal(distanceLabel(null), null);
});

test('the facts, headline and prose come from the record only', () => {
  const record = normalizeIncident(incidents[0]);
  const facts = incidentFacts(record);
  assert.equal(facts.type, 'Vehicle vs barrier');
  assert.equal(facts.vehicles, 4);
  assert.equal(facts.closureHours, 7);
  assert.equal(facts.fatalities, 1);

  const headline = incidentHeadline(facts);
  assert.deepEqual(headline.map(card => card.label), ['Fatality', 'Lanes closed for', 'Vehicles involved']);

  const prose = incidentNarrative(record, carriagewayAt(record.longitude, record.latitude, lines));
  assert.match(prose[0], /Vehicle vs barrier involving 4 vehicles/);
  assert.match(prose.join(' '), /Lanes were closed for 7 hours/);
  // Nothing may claim a delay: the register does not record one.
  assert.doesNotMatch(prose.join(' '), /delay|min\b/i);
});

test('a sparse record produces short prose and short lists rather than padded ones', () => {
  const record = normalizeIncident({ incident_id: 'INC-1', incident_type: 'Rear-end crash' });
  const prose = incidentNarrative(record, null);
  assert.match(prose[0], /Rear-end crash on the I-595 corridor/);
  assert.match(prose[1], /No lane closure was recorded/);
  assert.equal(incidentHeadline(incidentFacts(record)).length, 0);
  assert.ok(impactRows(record, null).every(([, value]) => value != null));
  assert.ok(detailFacts(record, null).every(([, value]) => value != null));
});

test('the reported date reads as the calendar day the record names, whatever the reader\'s timezone', () => {
  // "2024-07-16T00:00:00" is a calendar date with no zone. Read as an instant it becomes the 15th
  // east of Greenwich, which put the panel's heading a day behind the card beside it.
  const record = normalizeIncident({ incident_id: 'INC-1', incident_type: 'Vehicle fire', incident_date: '2024-07-16T00:00:00', incident_time: '13:00' });
  assert.equal(reportedAt(incidentFacts(record)), 'Jul 16, 2024 · 13:00');
});
