/**
 * Carriageway classification from FL511 prose, and section resolution within it.
 *
 * The prose strings here are real FL511 phrasings taken from the live feed, not invented shapes.
 * The property under test throughout is restraint: the classifier must refuse anything it cannot
 * evidence, because an event assigned to the wrong carriageway is worse than an unresolved one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CARRIAGEWAYS, CONFIDENCE, classifyCarriageway, sourceText } from '../server/carriageway.mjs';
import { corridorSections, resolveSection, sectionIdFor } from '../server/corridorSections.mjs';

const event = text => ({ description: text });

test('an explicit I-595 direction classifies the general-purpose carriageway', () => {
  const east = classifyCarriageway(event('Incident Crash in Broward County on I-595 East, before Exit 1: SW 136th Ave.'));
  assert.equal(east.carriageway, CARRIAGEWAYS.EB_GENERAL);
  assert.equal(east.direction, 'EB');
  assert.equal(east.confidence, CONFIDENCE.HIGH);

  const west = classifyCarriageway(event('Off ramp backup in Broward County on I-595 West, ramp to Exit 7: Davie Rd.'));
  assert.equal(west.carriageway, CARRIAGEWAYS.WB_GENERAL);
  assert.equal(west.direction, 'WB');

  // FL511's other spellings of the same claim.
  assert.equal(classifyCarriageway(event('Crash on I-595 eastbound at Davie Rd')).carriageway, CARRIAGEWAYS.EB_GENERAL);
  assert.equal(classifyCarriageway(event('I-595 WB, left lane blocked')).carriageway, CARRIAGEWAYS.WB_GENERAL);
});

test('the reversible lane is the express facility, and its stated direction is kept', () => {
  // Real feed string: FL511 calls the managed lanes "Reversible Lane - I595".
  const reversible = classifyCarriageway(event('Construction Zone Planned construction in Broward County on Reversible Lane - I595 West, ramp to Ramp To I-75 S. Express.'));
  assert.equal(reversible.carriageway, CARRIAGEWAYS.EXPRESS);
  assert.equal(reversible.direction, 'WB');
});

test('a real I-595 general-purpose string resolves to the general-purpose carriageway', () => {
  const real = classifyCarriageway(event('Construction Zone Planned construction in Broward County on I-595 East, at Exit 1: SW 136th Ave. 2 Right lanes blocked.'));
  assert.equal(real.carriageway, CARRIAGEWAYS.EB_GENERAL);
  assert.equal(real.direction, 'EB');
  assert.equal(real.confidence, CONFIDENCE.HIGH);
});

test('express outranks the direction it happens to state', () => {
  // Reversible: a direction is recorded only because the source stated one.
  const stated = classifyCarriageway(event('Crash on I-595 Express Eastbound near Exit 5'));
  assert.equal(stated.carriageway, CARRIAGEWAYS.EXPRESS);
  assert.equal(stated.direction, 'EB', 'the stated direction is kept');
  assert.equal(stated.confidence, CONFIDENCE.HIGH);

  // No direction stated: none is invented, and none is guessed from the time of day.
  const bare = classifyCarriageway(event('Disabled vehicle in the 595 Express lanes'));
  assert.equal(bare.carriageway, CARRIAGEWAYS.EXPRESS);
  assert.equal(bare.direction, null);
});

test('"Port Everglades Expressway" is I-595\'s name, not the express facility', () => {
  // The corridor's own name contains "Expressway"; reading that as the managed lanes would put
  // general-purpose events on Express and strip them of a section.
  const named = classifyCarriageway(event('Crash on Port Everglades Expressway, I-595 East at Exit 9'));
  assert.equal(named.carriageway, CARRIAGEWAYS.EB_GENERAL);
});

test('bare EB/WB match as tokens, never inside a word', () => {
  assert.equal(classifyCarriageway(event('I-595 EB at MM 4')).carriageway, CARRIAGEWAYS.EB_GENERAL);
  // These must not read as a direction.
  for (const text of ['Crash near WEBSTER Ave on I-595', 'Vehicle fire at the EBB tide marina, I-595', 'Debris near NEWBURY Rd on I-595']) {
    assert.equal(classifyCarriageway(event(text)).carriageway, CARRIAGEWAYS.UNKNOWN, text);
  }
});

test('anything unevidenced stays UNKNOWN rather than being guessed', () => {
  const cases = [
    ['', 'no-source-text'],
    ['Crash in Broward County. Last updated at 09:42 PM.', 'no-i595-evidence'],
    // I-595 is named, but the direction describes a ramp between the carriageways, not one of them.
    ['Closure on I-595 between the eastbound and westbound ramps', 'i595-not-the-subject'],
    // Another road named and I-595 absent: not ours, however near the corridor it sits.
    ['Incident Crash in Broward County on I-95 South, before MM 26.', 'names-another-road'],
    // Real feed strings that used to classify as I-595 Express: other roads' managed lanes, and
    // another road's expressway, all of which merely mention I-595 as a landmark.
    ['Closure Planned construction in Broward County on 75 Express South, ramp from I-75 Mainline/I-595/SR-869.', 'names-another-road'],
    ['Closure Planned construction in Broward County on 95 Express North, ramp from I-595 Mainline/Tpk/US-441.', 'names-another-road'],
    ['Closure Planned construction in Broward County on Sawgrass Expressway South, ramp to Exit 0: I-75/I-595.', 'names-another-road'],
    ['Closure Planned construction in Broward County on I-95 North, ramp to Exit 24: I-595. Off-ramp closed.', 'names-another-road'],
    // The direction belongs to US-441; I-595 is the far end of the work zone.
    ['Construction Zone Scheduled Road Work on US-441 Northbound from Oakes Rd to 0.5 Mi Beyond I-595 Westbound.', 'names-another-road'],
  ];
  for (const [text, method] of cases) {
    const result = classifyCarriageway(event(text));
    assert.equal(result.carriageway, CARRIAGEWAYS.UNKNOWN, text);
    assert.equal(result.method, method, text);
    assert.equal(result.confidence, CONFIDENCE.LOW);
  }
});

test('every field FL511 writes prose into is read', () => {
  const text = sourceText({
    title: 'Incident Crash', description: 'on I-595 East', comment: 'two lanes blocked',
    detailFields: [{ label: 'Region', value: 'Broward' }],
  });
  for (const part of ['Incident Crash', 'I-595 East', 'two lanes blocked', 'Broward']) {
    assert.match(text, new RegExp(part));
  }
});

// ── section resolution ────────────────────────────────────────────────────────────────────────
// Two parallel lines 40 m apart, standing in for the real carriageways, which are 17–40 m apart.
const SEGMENTS = [
  { segmentId: 'I595-EB-FDOT-000000-004182', direction: 'EB', index: 1, coordinates: [[-80.34, 26.118], [-80.32, 26.118]] },
  { segmentId: 'I595-EB-FDOT-004182-005142', direction: 'EB', index: 2, coordinates: [[-80.32, 26.118], [-80.30, 26.118]] },
  { segmentId: 'I595-WB-FDOT-000000-004182', direction: 'WB', index: 1, coordinates: [[-80.34, 26.1184], [-80.32, 26.1184]] },
  { segmentId: 'I595-WB-FDOT-004182-005142', direction: 'WB', index: 2, coordinates: [[-80.32, 26.1184], [-80.30, 26.1184]] },
];
const at = (longitude, latitude) => ({ longitude, latitude });

test('a classified carriageway is searched alone, so the nearer opposite line cannot win', () => {
  // Sitting ON the westbound line but classified eastbound — the situation the whole design exists
  // for. Geometry would answer WB; the classification must hold.
  const point = at(-80.33, 26.1184);
  const eb = resolveSection(point, CARRIAGEWAYS.EB_GENERAL, SEGMENTS);
  assert.equal(eb.segmentId, 'I595-EB-FDOT-000000-004182', 'resolved within the eastbound carriageway');
  assert.equal(eb.candidateCount, 2, 'only the eastbound segments were candidates');
  assert.equal(eb.sectionId, 'SECTION_01');

  const wb = resolveSection(point, CARRIAGEWAYS.WB_GENERAL, SEGMENTS);
  assert.equal(wb.segmentId, 'I595-WB-FDOT-000000-004182');
  // Same place, two carriageways, two answers — decided by the classification, not by distance.
  assert.notEqual(eb.segmentId, wb.segmentId);
});

test('express and unknown resolve to no section, and say which they are', () => {
  const point = at(-80.33, 26.118);
  const express = resolveSection(point, CARRIAGEWAYS.EXPRESS, SEGMENTS);
  assert.equal(express.sectionId, null);
  assert.equal(express.segmentId, null);
  assert.equal(express.method, 'express-no-sections');

  const unknown = resolveSection(point, CARRIAGEWAYS.UNKNOWN, SEGMENTS);
  assert.equal(unknown.sectionId, null);
  assert.equal(unknown.method, 'carriageway-unknown');
});

test('beyond tolerance the carriageway stands but the section does not', () => {
  // Far north of both lines: on the corridor by classification, on no section by geometry.
  const far = resolveSection(at(-80.33, 26.16), CARRIAGEWAYS.EB_GENERAL, SEGMENTS, { toleranceMeters: 120 });
  assert.equal(far.sectionId, null);
  assert.equal(far.method, 'beyond-tolerance');
  assert.ok(far.distanceMeters > 120, 'how far off it was is reported, not hidden');
});

test('a boundary event reports how close the next section was', () => {
  const boundary = resolveSection(at(-80.32, 26.118), CARRIAGEWAYS.EB_GENERAL, SEGMENTS);
  assert.ok(boundary.sectionId, 'it still resolves');
  assert.equal(boundary.runnerUpMeters, 0, 'and admits the neighbouring section was just as close');
});

test('sections are the eight FDOT bands, per carriageway, never merged', () => {
  const sections = corridorSections(SEGMENTS);
  assert.equal(sections.length, 4);
  const eb1 = sections.find(s => s.carriageway === CARRIAGEWAYS.EB_GENERAL && s.sectionIndex === 1);
  const wb1 = sections.find(s => s.carriageway === CARRIAGEWAYS.WB_GENERAL && s.sectionIndex === 1);
  // The same longitudinal band, two separate operational sections.
  assert.equal(eb1.sectionId, wb1.sectionId, 'they share the corridor band');
  assert.notEqual(eb1.segmentId, wb1.segmentId, 'but not the segment');
  assert.equal(eb1.sectionLabel, 'Eastbound Section 01');
  assert.equal(wb1.sectionLabel, 'Westbound Section 01');
  assert.equal(sectionIdFor(3), 'SECTION_03');
});

test('the browser vocabulary cannot drift from the server\'s', async () => {
  const client = await import('../src/liveOps/carriagewayModel.js');
  const server = await import('../server/carriageway.mjs');
  assert.deepEqual(client.CARRIAGEWAYS, server.CARRIAGEWAYS);
  assert.deepEqual(client.CARRIAGEWAY_LABELS, server.CARRIAGEWAY_LABELS);
  // Only the general-purpose carriageways have sections in this version.
  assert.equal(client.hasSections(CARRIAGEWAYS.EB_GENERAL), true);
  assert.equal(client.hasSections(CARRIAGEWAYS.WB_GENERAL), true);
  assert.equal(client.hasSections(CARRIAGEWAYS.EXPRESS), false);
  assert.equal(client.hasSections(CARRIAGEWAYS.UNKNOWN), false);
});

test('a record says where it is, including when that is nowhere', async () => {
  const { placeLabel } = await import('../src/liveOps/carriagewayModel.js');
  assert.equal(placeLabel({ carriageway: 'EB_GENERAL', sectionLabel: 'Eastbound Section 03' }), 'Eastbound Section 03');
  assert.equal(placeLabel({ carriageway: 'EXPRESS', direction: 'EB' }), 'I-595 Express · EB');
  // Reversible and unstated: no direction is shown rather than a default one.
  assert.equal(placeLabel({ carriageway: 'EXPRESS', direction: null }), 'I-595 Express');
  assert.equal(placeLabel({ carriageway: 'UNKNOWN' }), 'Carriageway unresolved');
  assert.equal(placeLabel(null), 'Unresolved');
});
