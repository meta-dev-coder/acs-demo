/**
 * Manual overrides of parking cohorts, with an append-only audit record.
 *
 * TWO KINDS, AND ONLY WHERE THEY ARE HONEST.
 *   MANUAL_ESTIMATE  a returning cohort the report cannot reconstruct (no earlier departure):
 *                    replace its estimated cars and, optionally, its exit window.
 *   RECONCILIATION   a cohort the report DOES hold (a departure whose cars return later): its
 *                    parked count is adjusted at the departure, so the same cars enter then and
 *                    leave on the return. It needs an explicit acknowledgement as well as a reason,
 *                    because it changes a cohort that was otherwise calculated.
 * Every set or clear appends one audit entry (when, which cohort, from, to, reason). Nothing here
 * changes a cohort silently; the engine (`applyOverride` in turnaroundModel.js) ignores any
 * override without a reason or of the wrong kind for its cohort.
 */

export const OVERRIDE_KIND = Object.freeze({ MANUAL_ESTIMATE: 'MANUAL_ESTIMATE', RECONCILIATION: 'RECONCILIATION' });

const MIN_REASON = 5;

/** Problems with an override before it is recorded, as sentences. */
export function overrideIssues({ cohort, kind, vehicles, exitStartMin, exitEndMin, reason, acknowledged }) {
  const out = [];
  if (!cohort) return ['No cohort selected.'];
  if (kind === OVERRIDE_KIND.MANUAL_ESTIMATE && cohort.kind !== 'ESTIMATED_RETURN') {
    out.push('These cars were parked by a departure in the report, so they cannot be re-estimated. Use a reconciliation adjustment on that departure instead.');
  }
  if (kind === OVERRIDE_KIND.RECONCILIATION && cohort.kind !== 'DEPARTING') out.push('Only a cohort parked by a departure in the report can be reconciled.');
  if (!(Number(vehicles) >= 0) || !Number.isInteger(Number(vehicles))) out.push('Enter a whole number of cars, 0 or more.');
  if (kind === OVERRIDE_KIND.MANUAL_ESTIMATE && (exitStartMin !== null && exitStartMin !== undefined)) {
    if (!(Number(exitEndMin) > Number(exitStartMin)) || Number(exitStartMin) < 0) out.push('The exit window must start at or after arrival and end after it starts.');
  }
  if (String(reason ?? '').trim().length < MIN_REASON) out.push('Give a reason for the override (at least a few words) — it is kept in the audit record.');
  if (kind === OVERRIDE_KIND.RECONCILIATION && !acknowledged) out.push('Confirm that this changes a calculated cohort: the adjusted cars enter at the departure and leave on the return.');
  return out;
}

/**
 * Record an override: NEW `cohortOverrides` and `overrideAudit`.
 * @param {{ cohortOverrides?: object, overrideAudit?: object[] }} state
 */
export function recordOverride(state, { cohort, kind, vehicles, exitStartMin = null, exitEndMin = null, reason, acknowledged = false, at = new Date().toISOString() }) {
  const issues = overrideIssues({ cohort, kind, vehicles, exitStartMin, exitEndMin, reason, acknowledged });
  if (issues.length) return { ...state, issues };
  const previous = state.cohortOverrides?.[cohort.id] ?? null;
  const o = {
    kind, vehicles: Number(vehicles), reason: String(reason).trim(), at,
    ...(kind === OVERRIDE_KIND.MANUAL_ESTIMATE && exitStartMin !== null && exitStartMin !== undefined ? { exitStartMin: Number(exitStartMin), exitEndMin: Number(exitEndMin) } : {}),
  };
  return {
    cohortOverrides: { ...(state.cohortOverrides ?? {}), [cohort.id]: o },
    overrideAudit: [...(state.overrideAudit ?? []), {
      at, action: 'SET', cohortId: cohort.id, kind, ship: cohort.shipName,
      from: previous ? previous.vehicles : cohort.calculatedVehicles ?? cohort.vehicles, to: o.vehicles, reason: o.reason,
    }],
    issues: [],
  };
}

/** Remove an override; the calculated cohort applies again. Audited too. */
export function clearOverride(state, { cohort, at = new Date().toISOString() }) {
  const previous = state.cohortOverrides?.[cohort.id];
  if (!previous) return { cohortOverrides: state.cohortOverrides ?? {}, overrideAudit: state.overrideAudit ?? [] };
  const { [cohort.id]: _drop, ...rest } = state.cohortOverrides;
  return {
    cohortOverrides: rest,
    overrideAudit: [...(state.overrideAudit ?? []), {
      at, action: 'CLEARED', cohortId: cohort.id, kind: previous.kind, ship: cohort.shipName,
      from: previous.vehicles, to: cohort.calculatedVehicles ?? null, reason: 'Override removed; calculated value restored.',
    }],
  };
}
