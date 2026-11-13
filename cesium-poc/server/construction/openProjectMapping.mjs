/**
 * Linking a live OpenProject activity to a synthetic P6 one — as a proposal, with its evidence.
 *
 * The temptation this module exists to refuse: OpenProject work package 38 is called "Cast Level 2
 * Columns" and the demo's P6 activity A-1020 is called "Cast Level 2 columns". Matching those two
 * strings is trivial, and a demo that silently merged them would look impressive and be wrong —
 * two systems can hold identically named activities that are not the same scope of work, and a
 * name is not an identifier.
 *
 * So the name match is produced as EVIDENCE, scored and labelled WEAK, and it buys nothing until a
 * person with the right role approves it. After approval, all it unlocks is a side-by-side read.
 *
 * And the comparison is never a verdict. Two progress percentages from two systems with different
 * baselines and different progress semantics differ for reasons that have nothing to do with the
 * work, which is why `COMPARISON_CAVEAT` travels with every difference this module computes.
 */
import { COMPARISON_CAVEAT, MAPPING, SOURCE } from './openProjectConfig.mjs';
import { links, proposeLink } from './openProjectStore.mjs';

/** Names, reduced for comparison only. The reduced form is never stored or shown as the name. */
export const normalizeName = value => String(value ?? '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * How strongly two names agree, and how much that is worth.
 *
 * Returns a BASIS word, not a boolean, because the three cases call for different handling:
 * an exact match after case and punctuation folding is still only a name match; a partial one is
 * weaker again; and no match at all means there is nothing to propose.
 */
export function nameEvidence(liveName, syntheticName) {
  const a = normalizeName(liveName);
  const b = normalizeName(syntheticName);
  if (!a || !b) return { basis: 'NONE', score: 0, detail: 'One of the two names is missing.' };
  if (a === b) {
    return { basis: 'NAME_EXACT', score: 0.9,
      detail: `Both systems call this activity "${liveName}" (identical after folding case and `
        + 'punctuation). A matching name is weak evidence: two systems can hold identically named '
        + 'activities covering different scopes of work.' };
  }
  const tokensA = new Set(a.split(' '));
  const tokensB = new Set(b.split(' '));
  const shared = [...tokensA].filter(token => tokensB.has(token));
  const overlap = shared.length / Math.max(tokensA.size, tokensB.size);
  if (overlap >= 0.6) {
    return { basis: 'NAME_PARTIAL', score: Math.round(overlap * 100) / 100,
      detail: `The names share ${shared.length} of ${Math.max(tokensA.size, tokensB.size)} words `
        + `("${shared.join('", "')}"). Weaker than an exact match and still only a name.` };
  }
  return { basis: 'NONE', score: Math.round(overlap * 100) / 100,
    detail: 'The names do not agree closely enough to propose a candidate.' };
}

/**
 * The synthetic P6 activities this demo holds, read from the mock source table.
 *
 * `src_p6_activity` is the MOCK SOURCE — what a real P6 would have returned. Read-only here: this
 * module has no statement that writes to it, which is the guarantee that approving a link cannot
 * overwrite synthetic progress.
 */
export function syntheticP6Activities(db) {
  return db.prepare(`SELECT activity_id, name, wbs_code, planned_start, planned_finish,
      pct_complete, rev, data_date FROM src_p6_activity ORDER BY activity_id`).all()
    .map(row => ({
      activityId: row.activity_id,
      name: row.name,
      wbsCode: row.wbs_code,
      plannedStart: row.planned_start,
      plannedFinish: row.planned_finish,
      reportedProgressPct: row.pct_complete == null ? null : Number(row.pct_complete),
      sourceRevision: row.rev,
      dataDate: row.data_date,
      kind: 'SYNTHETIC',
      label: 'Primavera P6 demo data (synthetic)',
    }));
}

/**
 * Candidates for one live activity, best first.
 *
 * Produces proposals, not decisions. An activity with several plausible candidates yields several,
 * and the screen shows them all — choosing silently among them is exactly the behaviour the
 * existing mapping layer was built to avoid.
 */
export function candidatesFor(activity, syntheticActivities) {
  return syntheticActivities
    .map(target => ({ target, evidence: nameEvidence(activity?.activityName, target.name) }))
    .filter(entry => entry.evidence.basis !== 'NONE')
    .sort((a, b) => b.evidence.score - a.evidence.score)
    .map(entry => ({
      targetSystem: 'P6',
      targetActivityId: entry.target.activityId,
      targetName: entry.target.name,
      targetProgressPct: entry.target.reportedProgressPct,
      basis: entry.evidence.basis,
      score: entry.evidence.score,
      detail: entry.evidence.detail,
      /** Said on every candidate, because the arrow only ever points one way: nowhere. */
      effect: 'Approving this link enables a read-only side-by-side comparison. It does not copy '
        + 'progress, dates or work estimates in either direction.',
    }));
}

/**
 * Propose the candidates for every live activity that has one and is not already linked.
 *
 * Deliberately only the STRONGEST candidate per activity is proposed, and only when nothing is
 * proposed or decided for that activity yet — so a rejected link is not re-proposed on the next
 * refresh, which would be a screen arguing with its own reviewer.
 */
export function proposeCandidates(db, { projectId, activities, actor = 'Integration service' }) {
  const synthetic = syntheticP6Activities(db);
  const existing = links(db, projectId);
  const decided = new Set(existing.map(link => String(link.externalId)));
  const proposed = [];
  for (const activity of activities) {
    const id = activity?.externalActivityId;
    if (!id || decided.has(String(id))) continue;
    const [best] = candidatesFor(activity, synthetic);
    if (!best) continue;
    const outcome = proposeLink(db, { projectId, externalId: id,
      targetActivityId: best.targetActivityId, targetSystem: best.targetSystem,
      basis: best.basis,
      evidence: { score: best.score, detail: best.detail, liveName: activity.activityName,
        targetName: best.targetName },
      actor });
    if (outcome.created) proposed.push(outcome.link);
  }
  return proposed;
}

/**
 * The comparison an APPROVED link unlocks. Read-only, and caveated.
 *
 * Returns `null` for anything not approved — that is the gate, enforced here rather than in the
 * screen, so a second caller cannot bypass it by asking differently.
 */
export function compare({ link, activity, target }) {
  if (!link || link.status !== MAPPING.APPROVED) return null;
  if (!activity || !target) return null;
  const live = activity.reportedProgressPct;
  const synthetic = target.reportedProgressPct;
  const comparable = live != null && synthetic != null;
  return {
    linkId: link.id,
    approvedAt: link.decidedAt,
    approvedBy: link.decidedBy,
    live: {
      system: SOURCE.label,
      kind: 'LIVE',
      id: activity.externalActivityId,
      name: activity.activityName,
      progressPct: live,
      plannedStart: activity.plannedStart,
      plannedFinish: activity.plannedFinish,
      status: activity.status,
      asOf: activity.sourceUpdatedAt,
    },
    synthetic: {
      system: 'Primavera P6 demo data',
      kind: 'SYNTHETIC',
      id: target.activityId,
      name: target.name,
      progressPct: synthetic,
      plannedStart: target.plannedStart,
      plannedFinish: target.plannedFinish,
      asOf: target.dataDate,
    },
    /** Percentage POINTS, and named as points — a 55-point gap is not "55% different". */
    differencePoints: comparable ? Math.round((live - synthetic) * 100) / 100 : null,
    comparable,
    /** Travels with the number, every time. */
    caveat: COMPARISON_CAVEAT,
    writeBack: 'None. This comparison is read-only; neither system has been written to.',
  };
}
