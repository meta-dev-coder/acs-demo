/**
 * The Construction demo's six workspaces and four roles.
 *
 * Shaped exactly like `appNav.js`'s `NAV_SECTIONS` and `APP_ROLES`, because they are handed to
 * the same `installAppNav`. Reusing that bar is what keeps the sidebar, the icons, the keyboard
 * behaviour and the `data-section` convention identical to I-595 without a second nav component.
 *
 * PHASE 10A REGROUPED THESE AROUND THE WORK, NOT THE SYSTEMS. The demo had grown a section per
 * integration — an Integration Overview, a Construction Progress, a Mapping Workbench, an
 * Approval Center — so following one activity meant visiting four screens and re-selecting it in
 * each. The six below are the questions a construction manager actually asks, and every existing
 * screen is mounted unchanged underneath one of them as a subtab.
 *
 * `icon` names are drawn from the bar's existing set. Nothing new is added to it, so this project
 * cannot change how I-595 looks.
 */

export const CONSTRUCTION_SECTIONS = Object.freeze([
  /** What needs attention today. The landing screen. */
  Object.freeze({ id: 'projectOverview', label: 'Project Overview', icon: 'overview' }),
  /** One activity, plan to close. The primary workspace. */
  Object.freeze({ id: 'lifecycle', label: 'Construction Lifecycle', icon: 'liveOps' }),
  /** Sequencing, planned versus reported, and the elements each activity builds. */
  Object.freeze({ id: 'schedule4d', label: 'Schedule & 4D', icon: 'tmc' }),
  /** Published BIM versions, what changed, and the activity mappings. */
  Object.freeze({ id: 'bimCoordination', label: 'BIM Coordination', icon: 'layers' }),
  /** Investigate, propose, review evidence, decide. */
  Object.freeze({ id: 'decisions', label: 'Decisions & Approvals', icon: 'tolling' }),
  /** Synchronisation, exceptions, reconciliation and the audit trail. */
  Object.freeze({ id: 'integrationAudit', label: 'Integration & Audit', icon: 'maintenance' }),
]);

export const DEFAULT_CONSTRUCTION_SECTION = 'projectOverview';

/**
 * The people the proposal names, and what each may reach.
 *
 * The approvers are separated because the proposal separates them: the Planner approves INT-02
 * and the Finance Controller approves INT-05, and neither may do the other's job. The BIM
 * Coordinator decides whether an IFC element is the thing an activity builds.
 */
export const CONSTRUCTION_ROLES = Object.freeze([
  Object.freeze({ id: 'integrationLead', label: 'Integration Lead',
    sections: CONSTRUCTION_SECTIONS.map(entry => entry.id) }),
  Object.freeze({ id: 'planner', label: 'Project Planner (P6)',
    sections: ['projectOverview', 'lifecycle', 'schedule4d', 'bimCoordination', 'decisions',
      'integrationAudit'] }),
  Object.freeze({ id: 'bimCoordinator', label: 'BIM Coordinator',
    sections: ['projectOverview', 'lifecycle', 'schedule4d', 'bimCoordination',
      'integrationAudit'] }),
  Object.freeze({ id: 'financeController', label: 'Finance Controller',
    sections: ['projectOverview', 'schedule4d', 'decisions', 'integrationAudit'] }),
]);

/** A section id a role actually carries, falling back to the first one it does. */
export function resolveConstructionSection(id, roleId = CONSTRUCTION_ROLES[0].id) {
  const role = CONSTRUCTION_ROLES.find(entry => entry.id === roleId) ?? CONSTRUCTION_ROLES[0];
  return role.sections.includes(id) ? id : role.sections[0];
}
