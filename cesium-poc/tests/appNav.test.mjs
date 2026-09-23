import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SECTION, NAV_SECTIONS, resolveSection } from '../src/appNav.js';

test('the bar offers the four workspaces, in order, each with its own icon', () => {
  assert.deepEqual(NAV_SECTIONS.map(section => section.id), ['overview', 'traffic', 'maintenance', 'safety']);
  assert.deepEqual(NAV_SECTIONS.map(section => section.label), ['Overview', 'Traffic', 'Maintenance', 'Safety']);
  assert.equal(new Set(NAV_SECTIONS.map(section => section.icon)).size, NAV_SECTIONS.length);
  assert.equal(DEFAULT_SECTION, 'overview');
});

test('an unknown section falls back to the first rather than leaving nothing chosen', () => {
  assert.equal(resolveSection('safety'), 'safety');
  assert.equal(resolveSection('nope'), 'overview');
  assert.equal(resolveSection(undefined), 'overview');
});
