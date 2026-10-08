/**
 * Placing an incident on the piece of road it is actually on.
 *
 * The corridor is not one line: 16 mainline sections, a reversible express, 165 ramps and
 * connectors and 185 frontage-road features all run down it. The failure this guards against is a
 * confident wrong answer — colouring a kilometre and a half of mainline because an incident on a
 * ramp happened to be nearest to it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  describeRoadMatch, matchIncidentRoad, ROAD_KINDS, ROAD_PAINT_CONFIG, roadLabelText, roadPaintSlice, roadsFromGeoJson,
} from '../src/tmc/incidentRoadMatch.js';

const read = (file, kind, label) =>
  roadsFromGeoJson(JSON.parse(readFileSync(new URL(`../public/data/${file}`, import.meta.url))), { kind, label });

const ROADS = [
  ...read('i595_ramps_connectors_classified.geojson', ROAD_KINDS.RAMP,
    p => p.destination || p.ramp_type || p.road_type || null),
  ...read('sr84_frontage_roads.geojson', ROAD_KINDS.FRONTAGE),
  ...read('express-way.geojson', ROAD_KINDS.EXPRESS, () => 'I-595 Express'),
  ...read('i595_fdot_traffic_segments.geojson', ROAD_KINDS.MAINLINE_SECTION,
    p => `I-595 ${p.direction} Section ${String(p.fdot_segment_index).padStart(2, '0')}`),
];

const metresAlong = points => {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const k = Math.cos(((points[i - 1].latitude + points[i].latitude) / 2) * Math.PI / 180);
    total += Math.hypot((points[i].longitude - points[i - 1].longitude) * k,
      points[i].latitude - points[i - 1].latitude) * 111_320;
  }
  return total;
};

test('every published facility is loaded as candidate geometry', () => {
  const byKind = ROADS.reduce((all, road) => ({ ...all, [road.kind]: (all[road.kind] ?? 0) + 1 }), {});
  assert.equal(byKind[ROAD_KINDS.RAMP], 165);
  assert.equal(byKind[ROAD_KINDS.FRONTAGE], 185);
  assert.equal(byKind[ROAD_KINDS.EXPRESS], 1);
  assert.equal(byKind[ROAD_KINDS.MAINLINE_SECTION], 16);
  for (const road of ROADS) assert.ok(road.path.length >= 2, `${road.id} has a usable line`);
});

test('an incident on the mainline matches its own section, not a neighbouring ramp', () => {
  // A real reported position from the connected feed, on I-595 WB.
  const point = { longitude: -80.2599, latitude: 26.1013 };
  const match = matchIncidentRoad(point, ROADS);
  assert.equal(match.kind, ROAD_KINDS.MAINLINE_SECTION);
  assert.match(match.label, /^I-595 (EB|WB) Section \d\d$/);
  assert.ok(match.metres <= 5, `${match.metres} m from the line`);
  assert.equal(match.confidence, 'HIGH');
});

test('the painted stretch is the length claimed, not the whole road', () => {
  const point = { longitude: -80.2599, latitude: 26.1013 };
  const match = matchIncidentRoad(point, ROADS);
  const slice = roadPaintSlice(match, point);
  const painted = metresAlong(slice);
  const whole = metresAlong(match.road.path);
  assert.ok(Math.abs(painted - ROAD_PAINT_CONFIG.halfLengthMeters * 2) < 2, `${Math.round(painted)} m painted`);
  assert.ok(painted < whole / 3, 'a short stretch, not the section');
});

test('a short road paints what it has rather than running past its end', () => {
  // A ramp can be shorter than the configured band; the slice stops at the geometry.
  const ramp = ROADS.find(road => road.kind === ROAD_KINDS.RAMP && metresAlong(road.path) < 120);
  assert.ok(ramp, 'the corridor has ramps shorter than the paint length');
  const mid = ramp.path[Math.floor(ramp.path.length / 2)];
  const match = matchIncidentRoad(mid, ROADS);
  const painted = metresAlong(roadPaintSlice(match, mid));
  assert.ok(painted <= metresAlong(match.road.path) + 1, 'never longer than the road itself');
});

test('a position far from every published line matches nothing at all', () => {
  // Several kilometres north of the corridor. The honest answer is no road, not the closest one.
  assert.equal(matchIncidentRoad({ longitude: -80.40, latitude: 26.30 }, ROADS), null);
  assert.deepEqual(roadPaintSlice(null, { longitude: -80.40, latitude: 26.30 }), []);
  // And an unusable coordinate is refused rather than defaulted.
  assert.equal(matchIncidentRoad({ longitude: null, latitude: 26.1 }, ROADS), null);
  assert.equal(matchIncidentRoad(null, ROADS), null);
});

test('reach is a hard limit, so nothing is ever snapped to a distant road', () => {
  const point = { longitude: -80.2599, latitude: 26.1013 };
  assert.ok(matchIncidentRoad(point, ROADS, { reachMeters: 60 }));
  // With the reach tightened below the real offset, the match disappears rather than degrading.
  const tight = matchIncidentRoad(point, ROADS, { reachMeters: 1 });
  if (tight) assert.ok(tight.metres <= 1);
});

test('a tie goes to the more specific facility', () => {
  // Two lines equally close: the ramp is the better answer than the mainline running beside it.
  const shared = [{ longitude: -80.25, latitude: 26.10 }, { longitude: -80.24, latitude: 26.10 }];
  const roads = [
    { id: 'mainline', kind: ROAD_KINDS.MAINLINE_SECTION, label: 'I-595 EB Section 04', path: shared, properties: {} },
    { id: 'ramp', kind: ROAD_KINDS.RAMP, label: 'Davie Road', path: shared, properties: {} },
  ];
  assert.equal(matchIncidentRoad({ longitude: -80.245, latitude: 26.10 }, roads).kind, ROAD_KINDS.RAMP);
  // But a clearly closer road wins regardless of what kind it is.
  const closer = [{ longitude: -80.25, latitude: 26.1002 }, { longitude: -80.24, latitude: 26.1002 }];
  const biased = [
    { id: 'ramp-far', kind: ROAD_KINDS.RAMP, label: 'Far ramp', path: shared, properties: {} },
    { id: 'section-near', kind: ROAD_KINDS.MAINLINE_SECTION, label: 'Section 04', path: closer, properties: {} },
  ];
  assert.equal(matchIncidentRoad({ longitude: -80.245, latitude: 26.1002 }, biased).kind, ROAD_KINDS.MAINLINE_SECTION);
});

test('an approximate match says so rather than reading as a lane-level fix', () => {
  const roads = [{ id: 'r', kind: ROAD_KINDS.MAINLINE_SECTION, label: 'Section 04', properties: {},
    path: [{ longitude: -80.25, latitude: 26.10 }, { longitude: -80.24, latitude: 26.10 }] }];
  // About 44 m north of the line: inside reach, outside the confident band.
  const off = matchIncidentRoad({ longitude: -80.245, latitude: 26.1004 }, roads);
  assert.equal(off.confidence, 'APPROXIMATE');
  assert.ok(off.metres > ROAD_PAINT_CONFIG.confidentWithinMeters);
  const described = describeRoadMatch(off);
  assert.match(described.detail, /m from the reported position/);
  assert.equal(described.confidence, 'APPROXIMATE');
});

test('the description never claims a facility the data did not state', () => {
  const express = describeRoadMatch({ kind: ROAD_KINDS.EXPRESS, label: 'I-595 Express', direction: 'REVERSIBLE', metres: 9, confidence: 'HIGH' });
  assert.equal(express.kindLabel, 'I-595 Express');
  assert.match(express.detail, /REVERSIBLE/);
  const ramp = describeRoadMatch({ kind: ROAD_KINDS.RAMP, label: null, direction: null, metres: 3, confidence: 'HIGH' });
  assert.equal(ramp.title, 'Ramp / connector', 'an unnamed ramp is a ramp, not a guess at which one');
  assert.equal(describeRoadMatch(null), null);
});

test('a multi-destination ramp name becomes a label, not a banner', () => {
  // Ramp destinations are published as semicolon-separated lists — 10 of the 25 distinct values
  // carry more than one, the longest 63 characters. On a map chip that spans the corridor.
  assert.equal(roadLabelText('Orlando;Miami;Florida\'s Turnpike'), 'Orlando');
  assert.equal(roadLabelText('Port Everglades;Fort Lauderdale-Hollywood International Airport'), 'Port Everglades');
  // A single long name is truncated rather than allowed to run.
  const long = roadLabelText('Fort Lauderdale-Hollywood International Airport');
  assert.ok(long.length <= 24, long);
  assert.ok(long.endsWith('…'));
  assert.equal(roadLabelText('Davie Road'), 'Davie Road');
  assert.equal(roadLabelText(''), null);
  assert.equal(roadLabelText(null), null);
});

test('the described title uses the shortened label', () => {
  const described = describeRoadMatch({
    kind: ROAD_KINDS.RAMP, label: 'Orlando;Miami;Florida\'s Turnpike', direction: null, metres: 4, confidence: 'HIGH',
  });
  assert.equal(described.title, 'Orlando');
  assert.ok(!described.title.includes(';'));
});
