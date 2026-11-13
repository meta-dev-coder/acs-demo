/**
 * What changed in OpenProject since we last looked.
 *
 * `diffActivity` is PURE — two records in, a list of findings out — so every rule below is testable
 * against a fixture and the persistence layer is only responsible for storing. The rules, and why
 * each one is a rule rather than an obvious implementation:
 *
 *  - THE FIRST SIGHTING IS A BASELINE, not history. An activity we have never seen yields exactly
 *    one NEW_ACTIVITY and no PROGRESS_CHANGED, because "progress went from nothing to 25%" is a
 *    sentence about our storage, not about the work.
 *  - `lockVersion` IS NOT A COUNTER WE MAY DO ARITHMETIC ON. It moves by however many edits
 *    happened between two polls, in any increment. We compare it for INEQUALITY and record both
 *    values; we never subtract them and never require a step of one.
 *  - A REVISION THAT MOVED WITH NO TRACKED FIELD CHANGE IS METADATA_ONLY. Somebody edited a
 *    description, added a comment or changed an assignee. Reporting that as a progress change
 *    would be inventing a figure; reporting it as UNCHANGED would hide a real edit.
 *  - A TRACKED FIELD THAT MOVED WHILE THE REVISION DID NOT is a SOURCE_CONFLICT. OpenProject's
 *    optimistic locking should make that impossible, so if we see it, one of the two is wrong and
 *    the screen must say so rather than pick a winner.
 *  - ONE REVISION CAN CARRY SEVERAL CHANGES. Each tracked field that moved is its own finding,
 *    with its own before and after. They are not collapsed into a count.
 */
import { CHANGE, EVENTFUL } from './openProjectConfig.mjs';

/**
 * The fields a change is reported about, and which finding each one produces.
 *
 * Adding a field here is the whole of adding it to change detection — the diff, the persistence
 * and the audit line all read this list, so they cannot drift apart.
 */
export const TRACKED = Object.freeze([
  Object.freeze({ field: 'reportedProgressPct', column: 'progress_pct',
    kind: CHANGE.PROGRESS_CHANGED, label: 'Progress %', numeric: true }),
  Object.freeze({ field: 'plannedStart', column: 'planned_start',
    kind: CHANGE.SCHEDULE_CHANGED, label: 'Planned start' }),
  Object.freeze({ field: 'plannedFinish', column: 'planned_finish',
    kind: CHANGE.SCHEDULE_CHANGED, label: 'Planned finish' }),
  Object.freeze({ field: 'status', column: 'status',
    kind: CHANGE.STATUS_CHANGED, label: 'Status' }),
  Object.freeze({ field: 'estimatedTimeRaw', column: 'estimated_raw',
    kind: CHANGE.WORK_ESTIMATE_CHANGED, label: 'Estimated work' }),
  Object.freeze({ field: 'remainingTimeRaw', column: 'remaining_raw',
    kind: CHANGE.WORK_ESTIMATE_CHANGED, label: 'Remaining work' }),
]);

/**
 * Are these two stored/incoming values the same value?
 *
 * SQLite hands numbers back as numbers and everything else as text, so `80` and `'80'` must
 * compare equal or every refresh would report a change. `null` and `''` are both "absent"; `null`
 * and `0` are emphatically not, which is why the absence test comes before the numeric one.
 */
export function sameValue(before, after, { numeric = false } = {}) {
  const absent = value => value == null || value === '';
  if (absent(before) && absent(after)) return true;
  if (absent(before) !== absent(after)) return false;
  if (numeric) {
    const a = Number(before);
    const b = Number(after);
    if (Number.isFinite(a) && Number.isFinite(b)) return a === b;
  }
  return String(before) === String(after);
}

/** A value as it is stored and shown. Never a cheerful stand-in for an absent one. */
const text = value => (value == null || value === '' ? null : String(value));

/**
 * Compare one incoming activity against its stored snapshot.
 *
 * @param {object|null} previous the stored snapshot row, or null on a first sighting
 * @param {object} current the normalized activity from the adapter
 * @returns {{externalId, kinds: string[], findings: object[], revisionMoved: boolean}}
 */
export function diffActivity(previous, current) {
  const externalId = current?.externalActivityId ?? null;
  const currentRevision = current?.sourceRevision ?? null;
  const previousRevision = previous?.source_revision ?? null;

  const base = {
    externalId,
    previousRevision,
    currentRevision,
    previousUpdatedAt: previous?.source_updated_at ?? null,
    currentUpdatedAt: current?.sourceUpdatedAt ?? null,
  };

  if (!previous) {
    return {
      ...base,
      kinds: [CHANGE.NEW_ACTIVITY],
      /**
       * One finding, no before-values. The baseline is explicitly NOT reported as a change from
       * zero: a reader who sees "progress 0% → 25%" on a first fetch will believe work happened
       * between two observations that never both existed.
       */
      findings: [{ kind: CHANGE.NEW_ACTIVITY, field: null, label: 'First observation',
        previous: null, current: text(current?.activityName), ...base,
        detail: 'First time this activity has been seen. Its current values are the baseline; no '
          + 'earlier values exist, so nothing is reported as having changed.' }],
      revisionMoved: false,
      baseline: true,
    };
  }

  const findings = [];
  for (const spec of TRACKED) {
    const before = previous[spec.column] ?? null;
    const after = current?.[spec.field] ?? null;
    if (sameValue(before, after, spec)) continue;
    findings.push({ kind: spec.kind, field: spec.field, label: spec.label,
      previous: text(before), current: text(after), ...base,
      detail: `${spec.label} changed from ${text(before) ?? 'not set'} to `
        + `${text(after) ?? 'not set'}.` });
  }

  /**
   * INEQUALITY, not an increment. `lockVersion` jumps by however many edits occurred between two
   * polls; requiring +1 would report a two-edit gap as no change at all.
   */
  const revisionMoved = previousRevision != null && currentRevision != null
    ? Number(previousRevision) !== Number(currentRevision)
    : !sameValue(previousRevision, currentRevision, { numeric: true });

  if (findings.length === 0) {
    if (revisionMoved) {
      return { ...base, revisionMoved, baseline: false, kinds: [CHANGE.METADATA_ONLY],
        findings: [{ kind: CHANGE.METADATA_ONLY, field: 'sourceRevision',
          label: 'Source revision', previous: text(previousRevision),
          current: text(currentRevision), ...base,
          detail: `The source revision moved from ${text(previousRevision) ?? 'not set'} to `
            + `${text(currentRevision) ?? 'not set'} but no tracked field changed. Something was `
            + 'edited in OpenProject that this screen does not track — a description, a comment, '
            + 'an assignee. No progress change is implied.' }] };
    }
    return { ...base, revisionMoved, baseline: false, kinds: [CHANGE.UNCHANGED], findings: [] };
  }

  if (!revisionMoved) {
    // Fields moved but the revision did not. Under optimistic locking that cannot happen, so we
    // report the contradiction rather than choosing which half to believe.
    findings.unshift({ kind: CHANGE.SOURCE_CONFLICT, field: 'sourceRevision',
      label: 'Source revision', previous: text(previousRevision), current: text(currentRevision),
      ...base,
      detail: `${findings.length} tracked field(s) changed while the source revision stayed at `
        + `${text(currentRevision) ?? 'not set'}. OpenProject increments lockVersion on every `
        + 'update, so these two statements contradict each other and neither is assumed correct.' });
  }

  return { ...base, revisionMoved, baseline: false,
    kinds: [...new Set(findings.map(entry => entry.kind))], findings };
}

/** Whether a finding is worth storing as an event. UNCHANGED is a fact, not an event. */
export const eventful = kind => EVENTFUL.includes(kind);

/**
 * Roll a set of per-activity diffs into the counts a screen and an audit line both need.
 *
 * `changed` counts ACTIVITIES, not findings: "3 changed" where one activity moved three fields
 * would otherwise read as three activities and overstate what happened.
 */
export function summarize(diffs) {
  const byKind = {};
  let changed = 0;
  let unchanged = 0;
  let created = 0;
  for (const diff of diffs) {
    for (const kind of diff.kinds) byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (diff.baseline) created += 1;
    else if (diff.kinds.includes(CHANGE.UNCHANGED)) unchanged += 1;
    else changed += 1;
  }
  return {
    activities: diffs.length,
    new: created,
    changed,
    unchanged,
    findings: diffs.reduce((sum, diff) => sum + diff.findings.length, 0),
    byKind,
  };
}
