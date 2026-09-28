import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SECTION, NAV_SECTIONS, resolveSection, sectionsForRole } from '../src/appNav.js';

test('the bar offers the workspaces, in order, each with its own icon', () => {
  assert.deepEqual(NAV_SECTIONS.map(section => section.id), ['traffic', 'maintenance', 'safety', 'liveOps']);
  assert.deepEqual(NAV_SECTIONS.map(section => section.label), ['Traffic', 'Maintenance', 'Safety', 'Live Ops']);
  assert.equal(new Set(NAV_SECTIONS.map(section => section.icon)).size, NAV_SECTIONS.length);
  assert.equal(DEFAULT_SECTION, 'liveOps');
});

test('an unknown section falls back to the first rather than leaving nothing chosen', () => {
  assert.equal(resolveSection('safety'), 'safety');
  assert.equal(resolveSection('nope'), 'traffic');
  assert.equal(resolveSection(undefined), 'traffic');
});

test('each role exposes only its assigned workspaces and rejects disallowed navigation', () => {
  for (const [role, expected] of Object.entries({ roadOperator: ['liveOps', 'safety'], maintenanceTeam: ['maintenance', 'safety'], agency: ['traffic', 'safety'] })) {
    const sections = sectionsForRole(role);
    assert.deepEqual(sections.map(s => s.id), expected);
    assert.equal(resolveSection('overview', sections), expected[0]);
    assert.equal(resolveSection('safety', sections), 'safety');
    for (const section of NAV_SECTIONS.filter(s => !expected.includes(s.id))) assert.equal(resolveSection(section.id, sections), expected[0]);
  }
});
