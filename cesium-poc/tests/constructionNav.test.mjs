/**
 * The Construction Integration Demo's navigation.
 *
 * The rule under test is isolation: these six workspaces exist only in this project, every role
 * that can reach them is this project's, and nothing about I-595's bar has moved. A section id
 * shared with I-595 would collide on `document.body.dataset.section`, which both projects write.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { APP_ROLES, NAV_SECTIONS } from '../src/appNav.js';
import {
  CONSTRUCTION_ROLES, CONSTRUCTION_SECTIONS, DEFAULT_CONSTRUCTION_SECTION,
  resolveConstructionSection,
} from '../src/construction/constructionNav.js';
import { WORKSPACE_BRIEF } from '../src/construction/constructionWorkspaces.js';

test('the six areas Phase 10A names, in order', () => {
  /*
   * Phase 10A regrouped the navigation around the WORK rather than the systems. The demo had
   * grown a section per integration, so following one activity meant visiting four screens and
   * re-selecting it in each. Every screen that existed is still mounted — as a subtab of the
   * area that matches the question it answers — and two are new.
   */
  assert.deepEqual(CONSTRUCTION_SECTIONS.map(entry => entry.label), [
    'Project Overview',
    'Construction Lifecycle',
    'Schedule & 4D',
    'BIM Coordination',
    'Decisions & Approvals',
    'Integration & Audit',
  ]);
  assert.equal(DEFAULT_CONSTRUCTION_SECTION, 'projectOverview');
});

test('no construction section id collides with an I-595 one', () => {
  const i595 = new Set(NAV_SECTIONS.map(entry => entry.id));
  for (const entry of CONSTRUCTION_SECTIONS) {
    assert.equal(i595.has(entry.id), false,
      `${entry.id} is also an I-595 section; both projects write document.body.dataset.section`);
  }
});

test('I-595’s own sections and roles are untouched', () => {
  assert.deepEqual(NAV_SECTIONS.map(entry => entry.id),
    ['traffic', 'maintenance', 'safety', 'liveOps', 'tmc', 'tolling', 'safetyIntel']);
  assert.deepEqual(APP_ROLES.map(role => role.id),
    ['roadOperator', 'maintenanceTeam', 'agency', 'tmc', 'tolling', 'safetyIntel']);
  // And no construction role has leaked into the I-595 list.
  const construction = new Set(CONSTRUCTION_ROLES.map(role => role.id));
  for (const role of APP_ROLES) assert.equal(construction.has(role.id), false);
});

test('every construction role reaches only construction sections, and at least one', () => {
  const known = new Set(CONSTRUCTION_SECTIONS.map(entry => entry.id));
  for (const role of CONSTRUCTION_ROLES) {
    assert.ok(role.sections.length > 0, `${role.id} can reach nothing`);
    for (const id of role.sections) {
      assert.ok(known.has(id), `${role.id} points at unknown section ${id}`);
    }
  }
});

test('the two approvers the proposal names are separate roles', () => {
  const ids = CONSTRUCTION_ROLES.map(role => role.id);
  assert.ok(ids.includes('planner'), 'the P6 planner approves INT-02');
  assert.ok(ids.includes('financeController'), 'the Finance controller approves INT-05');
  assert.notEqual('planner', 'financeController');
  /*
   * Both reach Decisions & Approvals; the BIM Coordinator does not.
   *
   * Phase 10A gave that role `approve:BIM_MAPPING` — deciding whether an IFC element is the
   * thing an activity builds is their judgement — but deliberately NOT a route to the approval
   * gates, and no say over the schedule. The two permissions are separate strings for exactly
   * this reason.
   */
  const reaches = id => CONSTRUCTION_ROLES.find(role => role.id === id).sections.includes('decisions');
  assert.equal(reaches('planner'), true);
  assert.equal(reaches('financeController'), true);
  assert.equal(reaches('bimCoordinator'), false);
});

test('a section a role cannot reach falls back to one it can', () => {
  // The BIM Coordinator has no business in Decisions & Approvals — the Planner and the Finance
  // Controller own those gates — so asking for it lands them on their own first area.
  assert.equal(resolveConstructionSection('decisions', 'bimCoordinator'), 'projectOverview');
  assert.equal(resolveConstructionSection('bimCoordination', 'bimCoordinator'), 'bimCoordination');
  assert.equal(resolveConstructionSection('nonesuch', 'planner'), 'projectOverview');
});

test('every area says what it is for, and invents no figure', () => {
  for (const section of CONSTRUCTION_SECTIONS) {
    const area = WORKSPACE_BRIEF[section.id];
    assert.ok(area, `${section.id} has no description`);
    assert.ok(area.purpose.length > 40, `${section.id} does not say what it is for`);
    assert.ok(area.subtabs.length > 0, `${section.id} mounts no screen`);
    // A placeholder count or percentage on a screen with no data behind it reads as a real one.
    assert.doesNotMatch(area.purpose,
      /\b\d+\s*%|\b\d{2,}\s+(records?|exceptions?|activities|elements)\b/,
      `${section.id} states a figure it has no data for`);
  }
});

test('every existing screen is still reachable after the regrouping', () => {
  // Phase 10A moved screens between areas; it did not drop any. A screen that quietly lost its
  // route would look exactly like a screen that was deleted.
  const subtabs = Object.values(WORKSPACE_BRIEF).flatMap(area => area.subtabs.map(t => t.label));
  for (const label of ['Schedule & Progress', 'BIM Timeline & Changes', 'Mapping Workbench',
    'Approval Center', 'Exceptions & Reconciliation', 'Interfaces & Live Sources',
    'Sync History & Audit']) {
    assert.ok(subtabs.includes(label), `${label} is no longer reachable`);
  }
});

test('no area subtab repeats a label used by a screen inside it', () => {
  // The area subtab bar sits directly above each screen's own tab bar. "Integration Overview"
  // appeared in both, one line apart, which said nothing about either of them.
  const subtabs = Object.values(WORKSPACE_BRIEF).flatMap(area => area.subtabs.map(t => t.label));
  assert.equal(new Set(subtabs).size, subtabs.length, 'two areas share a subtab label');
  for (const inner of ['Pilot Interfaces', 'SAP Live Cost', 'OpenProject Live Schedule',
    'BIM Timeline', 'BIM Changes']) {
    assert.ok(!subtabs.includes(inner), `${inner} is both an area subtab and an inner tab`);
  }
});
