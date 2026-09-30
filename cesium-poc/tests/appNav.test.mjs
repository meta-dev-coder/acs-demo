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
  for (const [role, expected] of Object.entries({ roadOperator: ['liveOps'], maintenanceTeam: ['maintenance'], agency: ['safety'] })) {
    const sections = sectionsForRole(role);
    assert.deepEqual(sections.map(s => s.id), expected);
    assert.equal(resolveSection('overview', sections), expected[0]);
    for (const section of NAV_SECTIONS.filter(s => !expected.includes(s.id))) assert.equal(resolveSection(section.id, sections), expected[0]);
  }
});

test('Safety belongs to the Agency alone; Traffic is built but offered to nobody', () => {
  // Both are still workspaces. Who may reach one is a role question, and a role that does not carry
  // a section cannot navigate to it — a ?section= deep link falls back to what that role does have.
  for (const id of ['safety', 'traffic']) assert.ok(NAV_SECTIONS.some(section => section.id === id));
  assert.deepEqual(sectionsForRole('agency').map(s => s.id), ['safety']);
  for (const [role, expected] of Object.entries({ roadOperator: 'liveOps', maintenanceTeam: 'maintenance', agency: 'safety' })) {
    const sections = sectionsForRole(role);
    assert.ok(!sections.some(section => section.id === 'traffic'), 'no role is offered Traffic');
    assert.equal(resolveSection('traffic', sections), expected);
  }
  // Only the Agency reaches Safety.
  assert.equal(resolveSection('safety', sectionsForRole('roadOperator')), 'liveOps');
  assert.equal(resolveSection('safety', sectionsForRole('agency')), 'safety');
});
