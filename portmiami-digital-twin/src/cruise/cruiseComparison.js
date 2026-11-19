/**
 * Baseline, A, B and C against the same day of cruise demand, and a ranking that says how it ranks.
 *
 * THE RANKING IS LEXICOGRAPHIC AND STATED. Alternatives are ordered by:
 *   1. unserved parking demand on the day (fewer is better),
 *   2. the peak parking shortage (smaller is better),
 *   3. peak utilisation of the facilities in play (lower is better).
 * A later criterion only breaks a tie in an earlier one. When the leading alternatives tie on
 * the first two — nobody is turned away under any of them — the result says the day does not
 * separate them on demand served, rather than crowning whichever has the most empty spaces.
 * Added capacity is reported beside demand served and never stands in for it.
 */

/** One row of the comparison table. */
export function cruiseMetrics(summary) {
  return {
    capacity: summary.capacity,
    accessibleCapacity: summary.accessibleCapacity,
    peakOccupied: summary.peakOccupied,
    peakTime: summary.peakTime,
    peakUtilisationPct: summary.peakUtilisationPct,
    unserved: summary.unserved,
    peakShortage: summary.peakShortage,
    peakShortageTime: summary.peakShortage > 0 ? summary.peakShortageTime : null,
    demandServedPct: summary.demandServedPct,
    demand: summary.demand,
    accommodated: summary.entries,
    garageUnserved: summary.garageUnserved,
    unallocated: summary.unallocated,
    garagesAtCapacity: summary.garagesAtCapacity,
    firstShortageTime: summary.firstShortageTime,
    noCapacityData: summary.noCapacityData,
  };
}

/**
 * @param {{key: string, name: string, metrics: object}[]} alternatives  not including the baseline
 * @returns {{ order: object[], best: object|null, tie: boolean, reason: string }}
 */
export function rankCruise(alternatives) {
  const order = [...alternatives].sort((a, b) =>
    a.metrics.unserved - b.metrics.unserved
    || a.metrics.peakShortage - b.metrics.peakShortage
    || (a.metrics.peakUtilisationPct ?? Infinity) - (b.metrics.peakUtilisationPct ?? Infinity)
    || String(a.key).localeCompare(String(b.key)));
  if (order.length < 2) {
    return { order, best: order[0] ?? null, leaders: order.slice(0, 1), tie: false, reason: 'Only one alternative to rank.' };
  }
  const [first] = order;
  const sameService = x => x.metrics.unserved === first.metrics.unserved && x.metrics.peakShortage === first.metrics.peakShortage;
  const leaders = order.filter(sameService);
  const rest = order.filter(x => !sameService(x));
  const names = list => list.map(x => x.name).join(list.length === 2 ? ' and ' : ', ');
  if (leaders.length === 1) {
    const second = order[1];
    return {
      order, best: first, leaders, tie: false,
      reason: first.metrics.unserved < second.metrics.unserved
        ? `${first.name} turns away the fewest vehicles (${first.metrics.unserved.toLocaleString()}).`
        : `${first.name} has the smallest peak shortage (${first.metrics.peakShortage.toLocaleString()} vehicles).`,
    };
  }
  if (!rest.length && first.metrics.unserved === 0) {
    return {
      order, best: null, leaders, tie: true,
      reason: 'Every alternative serves all of this day’s modelled demand, so the day does not separate them on demand served. Lower utilisation is shown, but it is spare capacity, not a better outcome.',
    };
  }
  if (!rest.length) {
    return { order, best: null, leaders, tie: true, reason: `${names(leaders)} turn away the same number of vehicles; they tie on demand served.` };
  }
  const outcome = first.metrics.unserved === 0 ? 'each parks every modelled vehicle' : `each turns away ${first.metrics.unserved.toLocaleString()} vehicles`;
  return {
    order, best: null, leaders, tie: true,
    reason: `${names(leaders)} tie for best: ${outcome}. ${rest.map(x => `${x.name} turns away ${x.metrics.unserved.toLocaleString()}`).join('; ')}. Lower utilisation among the leaders is spare capacity, not a better outcome.`,
  };
}

/** True when every case was given the same vehicles to park — the premise of the comparison. */
export function demandIdentical(rows) {
  return rows.every(r => r.metrics.demand === rows[0].metrics.demand);
}

const n0 = v => Math.round(v).toLocaleString('en-US');

/**
 * Why each alternative does or does not change the day's result, from the run itself: where its
 * spaces are, whether the day's active terminals can reach them under the access rules, and how
 * many cars they actually took.
 *
 * @param {object} p
 * @param {{key,id,name,metrics}[]} p.rows   baseline first
 * @param {Record<string, object>} p.summaries  summarizeDay per id
 * @param {Record<string, object>} p.sims       the runs, for the facilities each alternative added
 */
export function explainAlternatives({ rows, summaries, sims }) {
  const base = summaries.baseline;
  return rows.slice(1).map(row => {
    const sim = sims[row.id], s = summaries[row.id];
    const added = sim.facilities.filter(f => f.addedSpaces > 0 || f.proposed);
    if (!added.length) {
      return { id: row.id, key: row.key, text: 'No site chosen, so no spaces are added and the result equals the baseline.' };
    }
    // Terminals whose cars were turned away in the baseline: where extra spaces would have to reach.
    // ...including terminals with no garage at all, whose cars only an overflow design can reach.
    const shortCodes = [...new Set([...base.facilities.filter(f => f.unserved > 0).flatMap(f => f.servesTerminals), ...(base.unallocatedTerminals ?? [])])].sort();
    const parts = added.map(f => {
      const reachers = s.terminalAccess.filter(t => t.facilities.some(x => x.id === f.id)).map(t => t.code);
      const used = s.facilities.find(x => x.id === f.id)?.entries ?? 0;
      const where = `+${n0(f.addedSpaces)} spaces at ${f.name}`;
      if (!reachers.length) {
        const serves = f.servesTerminals.length ? `Terminal ${f.servesTerminals.join(', ')}` : 'no terminal';
        return `${where} serve ${serves}, which has no modelled cruise vehicles this day, so they do not count toward this day's demand`;
      }
      if (base.unserved === 0) return `${where} are reachable from Terminal ${reachers.join(', ')}, but existing garages already park every modelled car, so they stay spare`;
      const helps = shortCodes.filter(code => reachers.includes(code));
      if (!helps.length) {
        return `${where} serve Terminal ${reachers.join(', ')}, whose cars already fit; the cars turned away are at Terminal ${shortCodes.join(', ')}, which these spaces cannot serve under the access rules`;
      }
      return f.proposed
        ? `${where} take overflow from Terminal ${helps.join(', ')}: ${n0(used)} cars park there`
        : `${where} serve Terminal ${helps.join(', ')}, where cars were being turned away`;
    });
    const gain = base.unserved - row.metrics.unserved;
    const lead = gain > 0 ? `Parks ${n0(gain)} more cars than the baseline. ` : base.unserved > 0 ? 'Parks no more cars than the baseline. ' : '';
    const body = parts.join('; ');
    return { id: row.id, key: row.key, text: `${lead}${lead ? body : body[0].toUpperCase() + body.slice(1)}.` };
  });
}
