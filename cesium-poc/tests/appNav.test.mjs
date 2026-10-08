import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_ROLES, DEFAULT_SECTION, NAV_SECTIONS, resolveSection, sectionsForRole } from '../src/appNav.js';

test('the bar offers the workspaces, in order, each with its own icon', () => {
  assert.deepEqual(NAV_SECTIONS.map(section => section.id), ['traffic', 'maintenance', 'safety', 'liveOps', 'tmc']);
  assert.deepEqual(NAV_SECTIONS.map(section => section.label), ['Traffic', 'Maintenance', 'Safety', 'Live Ops', 'TMC']);
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

test('every role opens a workspace that exists, and the TMC is one of them', () => {
  // A role pointing at a section the bar does not carry would render an empty workspace with no
  // way back, so the two lists are checked against each other rather than kept in step by hand.
  const sections = new Set(NAV_SECTIONS.map(section => section.id));
  for (const role of APP_ROLES) {
    assert.ok(role.sections.length, `${role.id} opens nothing`);
    for (const id of role.sections) assert.ok(sections.has(id), `${role.id} opens unknown section ${id}`);
  }
  const tmc = APP_ROLES.find(role => role.id === 'tmc');
  // Short enough to read in full in the role dropdown, which clips a long label mid-word.
  assert.equal(tmc.label, 'TMC');
  assert.deepEqual(tmc.sections, ['tmc']);
  // One selector, one entry per role: a duplicate id would make the dropdown ambiguous.
  assert.equal(new Set(APP_ROLES.map(role => role.id)).size, APP_ROLES.length);
});

test('switching to the TMC role resolves to the TMC section', () => {
  const tmcSections = sectionsForRole('tmc').map(section => section.id);
  assert.deepEqual(tmcSections, ['tmc']);
  assert.equal(resolveSection('maintenance', sectionsForRole('tmc')), 'tmc',
    'a section the role does not carry falls back to one it does');
  // The other roles are untouched by the addition.
  assert.deepEqual(sectionsForRole('roadOperator').map(s => s.id), ['liveOps']);
  assert.deepEqual(sectionsForRole('agency').map(s => s.id), ['safety']);
});
