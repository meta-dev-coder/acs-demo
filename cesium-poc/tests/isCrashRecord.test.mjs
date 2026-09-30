/**
 * What belongs on the Safety screen.
 *
 * The FL511 feed files closures, roadworks and congestion in the same incident class as crashes.
 * Safety answers one question — where has this corridor hurt people — so it has to be able to tell
 * them apart, and the answer must not depend on how a row happens to be titled.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isCrashRecord } from '../src/assetExplorer/incidentTypes.js';

test('the register is all crashes: its rows carry no event type at all', () => {
  // Verified against the instance: 178 of 178 register records have no related.eventType.
  assert.equal(isCrashRecord({ title: 'Multi-vehicle crash', related: {} }), true);
  assert.equal(isCrashRecord({ title: 'Vehicle fire', related: { injuries: 'No' } }), true);
  assert.equal(isCrashRecord({ title: 'Guardrail strike' }), true);
  assert.equal(isCrashRecord({}), true);
});

test('a live closure or roadwork is not a crash, however it is titled', () => {
  // The four that put themselves on the crash map: FL511 closures, subtype Construction.
  const closure = { title: 'Closure', type: 'INCIDENT', related: { eventType: 'CLOSURE', injuries: 'NA' } };
  assert.equal(isCrashRecord(closure), false);
  assert.equal(isCrashRecord({ related: { eventType: 'CONSTRUCTION' } }), false);
  assert.equal(isCrashRecord({ related: { eventType: 'CONGESTION' } }), false);
  // Spelling and case come from a feed, not from us.
  assert.equal(isCrashRecord({ related: { eventType: ' closure ' } }), false);
});

test('a live crash still counts', () => {
  assert.equal(isCrashRecord({ related: { eventType: 'INCIDENT' } }), true);
  assert.equal(isCrashRecord({ related: { eventType: 'DISABLED' } }), true, 'a disabled vehicle is a roadside event, not roadworks');
});

test('anything that hurt somebody counts, however it was filed', () => {
  // Harm is the thing being mapped: a closure that injured someone is not filtered out on a
  // technicality of which queue it arrived in.
  assert.equal(isCrashRecord({ related: { eventType: 'CLOSURE', injuries: 'Yes' } }), true);
  assert.equal(isCrashRecord({ related: { eventType: 'CLOSURE', fatalities: 1 } }), true);
  assert.equal(isCrashRecord({ related: { eventType: 'CLOSURE', fatalities: 0, injuries: 'No' } }), false);
  assert.equal(isCrashRecord({ related: { eventType: 'CLOSURE', injuries: 'NA' } }), false, 'NA is not a yes');
});
