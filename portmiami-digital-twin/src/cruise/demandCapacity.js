/**
 * Parking demand against garage capacity, for one garage, one terminal or every garage in play —
 * the view the Cruise Parking Simulation is built around.
 *
 * FOUR QUANTITIES, NEVER MIXED.
 *   occupied   cars physically parked (closing occupancy of each 15 minutes)
 *   required   spaces the modelled demand needs: occupied, plus cars turned away that are still
 *              away on their voyage (they would be parked if there had been room), plus cars meant
 *              for a garage with no published capacity
 *   shortage   cars without parking: cars from THIS focus's terminals that were turned away and
 *              are still away on their voyage. Counted by terminal, so a design's shared overflow
 *              lot filling with other terminals' cars is never charged to this garage, and a free
 *              space in a garage these cars may not use never hides their shortage
 *   unallocated  cars from a terminal with no garage at all — a missing assignment, not a shortage
 * Cars meant for a garage with no published capacity are "unchecked": counted in required, never
 * in capacity or shortage.
 *
 * Everything is read from the simulation's per-interval records; nothing is recomputed here.
 */
import { localMidnightMs, nextDate, utcMsToLocal } from './cruiseCalls.js';
import { PROPOSED_SCOPE } from './cruiseAssumptions.js';

export const FOCUS = Object.freeze({ ALL: 'ALL', GARAGE: 'GARAGE', TERMINAL: 'TERMINAL' });

const hhmm = ms => utcMsToLocal(ms).time;
const MONTH_DAY = date => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const n0 = v => Math.round(v).toLocaleString('en-US');
const list = names => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** Facilities that take a terminal's overflow, as the model places it. */
const overflowFor = (sim, code) => sim.facilities.filter(f => !(sim.allocations[code] ?? []).some(r => r.facilityId === f.id)
  && (f.scope === PROPOSED_SCOPE.ANY_TERMINAL || (Array.isArray(f.scope) && f.scope.includes(code)) || (f.proposed && f.servesTerminals.includes(code))));

/** The terminals mapped to a garage. */
const terminalsOf = (sim, id) => Object.entries(sim.allocations).filter(([, rows]) => rows.some(r => r.facilityId === id)).map(([code]) => code).sort();

/**
 * The garages and terminals one focus covers in one run. A garage brings the overflow facilities
 * its terminals may use (so a design's added spaces that take its cars are counted); a terminal
 * brings its mapped garages and its overflow; ALL is every facility in play on the day.
 */
export function focusGroup(sim, summary, focus) {
  const byId = new Map(sim.facilities.map(f => [f.id, f]));
  if (focus.kind === FOCUS.GARAGE) {
    const terminals = terminalsOf(sim, focus.id);
    const ids = new Set([focus.id, ...terminals.flatMap(code => overflowFor(sim, code).map(f => f.id))]);
    return { facilities: [...ids].map(id => byId.get(id)).filter(Boolean), terminals };
  }
  if (focus.kind === FOCUS.TERMINAL) {
    const ids = new Set([...(sim.allocations[focus.id] ?? []).map(r => r.facilityId), ...overflowFor(sim, focus.id).map(f => f.id)]);
    return { facilities: [...ids].map(id => byId.get(id)).filter(Boolean), terminals: [focus.id] };
  }
  return { facilities: summary.facilities.map(f => byId.get(f.id)).filter(Boolean), terminals: summary.activeTerminals };
}

/**
 * Demand against capacity through one day, for one focus in one run.
 * @returns {{ series: object[], capacity: number, peak, maxShortage, firstShortage, ... }}
 */
export function demandVsCapacity(sim, summary, focus, date) {
  const { facilities, terminals } = focusGroup(sim, summary, focus);
  const known = facilities.filter(f => Number.isFinite(f.capacity));
  const capacity = known.reduce((t, f) => t + f.capacity, 0);
  const dayStart = localMidnightMs(date), dayEnd = localMidnightMs(nextDate(date));
  const rows = sim.intervals.filter(r => r.startMs >= dayStart && r.startMs < dayEnd);
  const terminalOf = new Map(sim.cohorts.map(c => [c.id, c.terminalCode]));
  const series = rows.map((r, index) => {
    const at = f => r.facilities[f.id];
    const sum = (key, set = facilities) => set.reduce((t, f) => t + (at(f)?.[key] ?? 0), 0);
    const occupied = sum('end');
    const shortage = terminals.reduce((t, code) => t + (r.terminalShort?.[code] ?? 0), 0);
    const unchecked = sum('noDataActive');
    const required = occupied + shortage + unchecked;
    return {
      index, startMs: r.startMs, time: hhmm(r.startMs),
      required, occupied, capacity,
      free: Math.max(0, capacity - sum('end', known)),
      shortage,
      pooledShortage: Math.max(0, occupied + shortage - capacity),
      unchecked,
      unallocated: terminals.reduce((t, code) => t + (r.unallocatedActive?.[code] ?? 0), 0),
      entries: sum('served'), exits: sum('exits'), rejected: sum('unserved'),
      // The breakdown the garage panel explains: opening occupancy, and this focus's cars turned
      // away IN this interval against those turned away earlier and still counted as unmet.
      startOccupied: sum('start'),
      rejectedNow: r.moves.filter(m => m.type === 'UNSERVED' && terminals.includes(terminalOf.get(m.cohortId))).reduce((t, m) => t + m.n, 0),
      garages: Object.fromEntries(facilities.map(f => [f.id, at(f)])),
    };
  });
  const peakAt = series.reduce((b, s, i) => (s.required > (series[b]?.required ?? -1) ? i : b), 0);
  // TODAY'S DENIALS against the BACKLOG. A car turned away stays unmet until its voyage returns, so
  // a garage can carry unmet demand from an earlier day into this one. That backlog is not a new
  // shortage at 00:00: it is reported apart from the cars denied on this date.
  const denied = series.filter(s => s.rejectedNow > 0);
  const gapAt = series.reduce((b, s, i) => (s.required - s.capacity > (series[b] ? series[b].required - series[b].capacity : -Infinity) ? i : b), 0);
  const maxAt = series.reduce((b, s, i) => (s.shortage > (series[b]?.shortage ?? 0) ? i : b), 0);
  const short = series.filter(s => s.shortage > 0);
  return {
    focus, date,
    label: focus.kind === FOCUS.GARAGE ? sim.facilities.find(f => f.id === focus.id)?.name ?? focus.id
      : focus.kind === FOCUS.TERMINAL ? `Terminal ${focus.id}` : 'All garages in play',
    facilities: facilities.map(f => ({ id: f.id, name: f.name, capacity: f.capacity, proposed: f.proposed, addedSpaces: f.addedSpaces, terminals: terminalsOf(sim, f.id) })),
    terminals,
    capacity,
    unknownCapacity: facilities.filter(f => !Number.isFinite(f.capacity)).map(f => f.name),
    missingAssignment: focus.kind === FOCUS.TERMINAL && facilities.length === 0,
    series,
    peak: series.length ? { value: series[peakAt].required, time: series[peakAt].time, index: peakAt } : null,
    maxShortage: short.length ? { value: series[maxAt].shortage, time: series[maxAt].time, index: maxAt } : { value: 0, time: null, index: null },
    firstShortage: short.length ? { time: short[0].time, index: short[0].index } : null,
    lastShortage: short.length ? { time: short.at(-1).time, index: short.at(-1).index } : null,
    shortageIntervals: short.length,
    deniedToday: series.reduce((t, s) => t + s.rejectedNow, 0),
    firstDenial: denied.length ? { time: denied[0].time, index: denied[0].index } : null,
    backlogAtStart: series.length ? Math.max(0, series[0].shortage - series[0].rejectedNow) : 0,
    // The peak capacity gap: spaces required above eligible capacity (0 when demand fits).
    maxGap: series.length && capacity > 0
      ? { value: Math.max(0, series[gapAt].required - capacity), time: series[gapAt].time, index: gapAt } : { value: 0, time: null, index: null },
    turnedAway: series.reduce((t, s) => t + s.rejected, 0),
    maxUnallocated: Math.max(0, ...series.map(s => s.unallocated)),
    maxUnchecked: Math.max(0, ...series.map(s => s.unchecked)),
    // Cars without parking while spaces in the group stand free: those spaces opened after the
    // cars were turned away, or are in a garage these cruises may not use.
    constrained: series.some(s => s.shortage > s.pooledShortage),
  };
}

/**
 * One sentence (two at most) for the selected time, from the interval's own moves: which cruises
 * are parking or collecting cars in these garages, how many spaces are needed against how many
 * exist, and what does not fit.
 */
export function explainDemandAt({ sim, dvc, index, brief = false }) {
  const s = dvc.series[index];
  if (!s) return '';
  const ids = new Set(dvc.facilities.map(f => f.id));
  const rec = sim.intervals.find(r => r.startMs === s.startMs);
  const byCohort = new Map(sim.cohorts.map(c => [c.id, c]));
  const arriving = new Map(), leaving = new Map();
  for (const m of rec.moves) {
    const c = byCohort.get(m.cohortId);
    const own = (m.facilityId && ids.has(m.facilityId)) || (m.type === 'UNALLOCATED' && dvc.terminals.includes(c.terminalCode));
    if (!own) continue;
    const bucket = m.type === 'OUT' ? leaving : arriving;
    bucket.set(c.shipName, (bucket.get(c.shipName) ?? 0) + m.n);
  }
  const fmtShips = map => list([...map].sort((a, b) => b[1] - a[1]).map(([ship, n]) => `${ship} (${n0(n)})`));
  const parts = [];
  if (arriving.size) parts.push(`cars for ${fmtShips(arriving)} are arriving to park`);
  if (leaving.size) parts.push(`returning passengers of ${fmtShips(leaving)} are collecting their cars`);
  const place = dvc.focus.kind === FOCUS.ALL ? 'the garages in play' : dvc.focus.kind === FOCUS.TERMINAL ? `the garages serving Terminal ${dvc.focus.id}` : dvc.label;
  // `brief`: the decision screen's one-line form — capacity, demand and gap at the time; which
  // ships are moving cars is left to the calculation details.
  const activity = brief ? `At ${s.time},` : parts.length ? `At ${s.time}, ${parts.join('; ')}.` : `At ${s.time}, no modelled cruise cars arrive at or leave ${place}.`;

  if (dvc.missingAssignment) {
    return `${activity} Terminal ${dvc.focus.id} has no garage in the mapping, so ${n0(s.unallocated)} cars that need parking cannot be assigned to one — a missing garage assignment, not a capacity shortage.`;
  }
  const where = dvc.focus.kind === FOCUS.ALL ? 'the garages in play have' : dvc.focus.kind === FOCUS.TERMINAL ? `the garages serving Terminal ${dvc.focus.id} have` : `${dvc.label} has`;
  const gap = s.required - dvc.capacity;
  const head = `${activity} ${brief ? where : `${where[0].toUpperCase()}${where.slice(1)}`} ${n0(dvc.capacity)} spaces (${n0(s.occupied)} occupied, ${n0(s.free)} free); combined cruise demand requires ${n0(s.required)}${gap > 0 ? ` — a ${n0(gap)}-space capacity gap` : ''}.`;
  // Cars denied earlier that are still away on their voyage: named, with the day they were denied.
  const carried = Math.max(0, s.shortage - s.rejectedNow);
  const sources = carried > 0 ? sim.cohorts
    .filter(c => dvc.terminals.includes(c.terminalCode) && c.unserved > 0 && c.entryStartMs < s.startMs && !(c.exitStartMs <= s.startMs))
    .map(c => `${c.shipName}, denied ${MONTH_DAY(utcMsToLocal(c.entryStartMs).date)}`) : [];
  const notes = [];
  if (s.rejectedNow > 0) notes.push(`${n0(s.rejectedNow)} arriving ${s.rejectedNow === 1 ? 'car' : 'cars'} cannot be accommodated now.`);
  if (carried > 0) {
    notes.push(`${n0(carried)} ${carried === 1 ? 'car' : 'cars'} denied earlier${sources.length ? ` (${list(sources)})` : ''} are still without parking until their ship returns; they do not retry${s.free > 0 ? `, so the ${n0(s.free)} free spaces do not reduce this` : ''}.`);
  }
  if (!s.rejectedNow && !carried) notes.push('No car is without parking.');
  const extra = [
    s.unallocated ? `${n0(s.unallocated)} cars have no garage assigned (a mapping gap, not a shortage).` : '',
    s.unchecked ? `${n0(s.unchecked)} cars are meant for a garage with no published capacity and cannot be checked.` : '',
  ].filter(Boolean);
  return [head, ...notes, ...extra].join(' ');
}

export const DESIGN_RESULT = Object.freeze({
  RESOLVES: 'RESOLVES', REDUCES: 'REDUCES', NO_CHANGE: 'NO_CHANGE', NO_SHORTAGE: 'NO_SHORTAGE', WORSE: 'WORSE',
  ASSIGNMENT_MISSING: 'ASSIGNMENT_MISSING', PROVIDES_ACCESS: 'PROVIDES_ACCESS',
});

export const DESIGN_RESULT_LABEL = Object.freeze({
  RESOLVES: 'Resolves the shortage',
  REDUCES: 'Reduces the shortage',
  NO_CHANGE: 'Does not resolve it',
  NO_SHORTAGE: 'No shortage to resolve',
  WORSE: 'Shortage larger',
  ASSIGNMENT_MISSING: 'Garage assignment missing',
  PROVIDES_ACCESS: 'Gives access (assumed)',
});

/**
 * Every design against the same focus and the same demand. A design is credited only through the
 * shortage it removes in these garages; capacity it adds elsewhere does not count.
 */
export function compareDesigns(dvcs, order) {
  const base = dvcs.baseline;
  const cards = order.map(({ id, key, name }) => {
    const d = dvcs[id];
    const result = d.missingAssignment ? DESIGN_RESULT.ASSIGNMENT_MISSING
      : base.missingAssignment ? DESIGN_RESULT.PROVIDES_ACCESS
        : base.maxShortage.value === 0 && d.maxShortage.value === 0 ? DESIGN_RESULT.NO_SHORTAGE
      : id === 'baseline' ? DESIGN_RESULT.NO_CHANGE
        : d.maxShortage.value === 0 && d.turnedAway === 0 ? DESIGN_RESULT.RESOLVES
          : d.turnedAway < base.turnedAway || d.maxShortage.value < base.maxShortage.value ? DESIGN_RESULT.REDUCES
            : d.turnedAway > base.turnedAway ? DESIGN_RESULT.WORSE : DESIGN_RESULT.NO_CHANGE;
    const assignment = base.missingAssignment && !d.missingAssignment ? 'Gives this terminal access to parking (assumed overflow access)'
      : d.missingAssignment ? 'No garage assigned to this terminal' : null;
    return {
      id, key, name, result, assignment,
      capacity: d.capacity, peakDemand: d.peak?.value ?? 0, peakTime: d.peak?.time ?? null,
      maxShortage: d.maxShortage.value, maxShortageTime: d.maxShortage.time,
      turnedAway: d.turnedAway, firstShortage: d.firstShortage?.time ?? null, shortageIntervals: d.shortageIntervals,
      deniedToday: d.deniedToday, firstDenial: d.firstDenial?.time ?? null, maxGap: d.maxGap.value,
      resolved: !d.missingAssignment && d.maxShortage.value === 0 && d.turnedAway === 0,
      maxUnallocated: d.maxUnallocated, maxUnchecked: d.maxUnchecked,
      peakUtilisationPct: d.capacity ? (Math.max(...d.series.map(s => s.occupied)) / d.capacity) * 100 : null,
      addedCapacity: d.capacity - base.capacity,
      sameDemand: true,
    };
  });
  return { cards, verdict: recommendDesign({ base, cards }) };
}

const QUALIFIER = 'This compares parking capacity only; cost, land, access, constructability and engineering feasibility are not modelled.';

/** A number of 15-minute intervals as "13 h 15 min" ("none" for zero), the same everywhere. */
export const durationLabel = intervals => {
  if (!intervals) return 'none';
  const h = Math.floor(intervals / 4), m = (intervals % 4) * 15;
  return [h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ');
};
const hours = durationLabel;

/** "Why?" — the calculated differences between the existing layout and one design. */
export function whyLines(base, c, added) {
  const out = [
    `Cars denied parking: ${n0(base.turnedAway)} → ${n0(c.turnedAway)}`,
    `Maximum unmet demand: ${n0(base.maxShortage)} → ${n0(c.maxShortage)}`,
    `Time with unmet demand: ${hours(base.shortageIntervals)} → ${hours(c.shortageIntervals)}`,
  ];
  if (base.firstShortage !== c.firstShortage) out.push(`First shortage: ${base.firstShortage ?? 'none'} → ${c.firstShortage ?? 'none'}`);
  out.push(added > 0 ? `Added spaces usable here: +${n0(added)}` : 'Adds no spaces these terminals can use');
  if (Number.isFinite(base.peakUtilisationPct) && Number.isFinite(c.peakUtilisationPct)) out.push(`Peak utilization: ${Math.round(base.peakUtilisationPct)}% → ${Math.round(c.peakUtilisationPct)}%`);
  return out;
}

/**
 * THE RECOMMENDATION — deterministic, from the comparison cards. Every card was simulated with the
 * same calls, assumptions, profile, horizon, initial occupancy, eligibility and allocation policy;
 * only the parking differs.
 *
 * PRIMARY: cars denied parking, maximum unmet demand, whether the shortage is fully resolved,
 * first shortage, and how long it lasts. SECONDARY: added spaces (usable by these terminals) and
 * peak utilization.
 *   5. Missing data first: a terminal with no garage, or a garage with no published capacity, gets
 *      no recommendation — the data needed is named.
 *   1. No shortage in the existing layout: no expansion, under the current model.
 *   2. Exactly one design resolves it: the only currently feasible modelled option.
 *   3. Several resolve it: all are feasible options; the one needing the fewest added spaces is
 *      named the most capacity-efficient — never the cheapest or best overall.
 *   4. None resolves it: the one that cuts denials (then unmet demand, then duration) most, stated
 *      plainly as not a full solution.
 * A design is never recommended for adding the most spaces: only usable spaces count, and only
 * through the shortage they remove. A design only "resolves" on a clean record — no cars whose
 * demand could not be tested (no garage, unknown capacity).
 */
export function recommendDesign({ base, cards }) {
  const baseCard = cards.find(c => c.id === 'baseline');
  const alts = cards.filter(c => c.id !== 'baseline');
  const label = base.label;
  const added = c => c.capacity - baseCard.capacity;
  const clean = c => c.maxUnallocated === 0 && c.maxUnchecked === 0;
  const short = c => c.name.split('.')[0];
  const headOf = c => ({ before: baseCard.maxShortage, after: c.maxShortage, added: added(c), why: whyLines(baseCard, c, added(c)) });

  // 5 — missing data.
  if (base.missingAssignment) {
    const access = alts.filter(c => c.result === DESIGN_RESULT.PROVIDES_ACCESS);
    return access.length
      ? { kind: 'ACCESS', tone: 'warn', options: access.map(c => c.id), headline: `Garage assignment needed for Terminal ${base.focus.id}`,
        needs: [`A garage for Terminal ${base.focus.id} in the terminal → garage mapping`],
        text: `Terminal ${base.focus.id} has no garage in the county mapping, so this is a missing assignment, not a capacity shortage. ${list(access.map(c => c.name))} would give its cars somewhere to park only through ${access.length > 1 ? 'their' : 'its'} configured terminal access — confirm that before relying on it.` }
      : { kind: 'ACCESS', tone: 'warn', headline: `Garage assignment needed for Terminal ${base.focus.id}`,
        needs: [`A garage for Terminal ${base.focus.id} in the terminal → garage mapping`],
        text: `Terminal ${base.focus.id} has no garage in the mapping and no design gives it access. Assign a garage before its demand can be tested against capacity — no design can be recommended until then.` };
  }
  if (!base.capacity && base.unknownCapacity?.length) {
    return { kind: 'DATA_NEEDED', tone: 'warn', headline: `Capacity not published for ${list(base.unknownCapacity)}`,
      needs: base.unknownCapacity.map(n => `A verified space count for ${n}`),
      text: `${list(base.unknownCapacity)} ${base.unknownCapacity.length > 1 ? 'have' : 'has'} no published capacity, so demand here cannot be tested against capacity and no design can be recommended. A verified space count is needed.` };
  }

  // 1 — no shortage today.
  if (baseCard.maxShortage === 0 && baseCard.turnedAway === 0) {
    return { kind: 'NONE_NEEDED', tone: 'ok', headline: 'No expansion needed under the current model',
      text: `The existing parking meets ${label}'s modelled demand on this date: no car is denied parking.${clean(baseCard) ? '' : ' Some demand here could not be tested (no garage assigned, or capacity not published), so this holds only for the demand that could be checked.'}`,
      ...(clean(baseCard) ? {} : { needs: ['Garage assignments or published capacities for the untested demand'] }) };
  }

  const resolves = alts.filter(c => c.maxShortage === 0 && c.turnedAway === 0 && added(c) > 0);
  const cleanResolvers = resolves.filter(clean);
  const untestable = resolves.filter(c => !clean(c));
  const untestedNote = untestable.length ? ` ${list(untestable.map(c => c.name))} also show no shortage, but only with untested demand, so ${untestable.length > 1 ? 'they are' : 'it is'} not counted.` : '';

  // 2 — exactly one.
  if (cleanResolvers.length === 1) {
    const [best] = cleanResolvers;
    return { kind: 'ONLY', tone: 'ok', best: best.id, headline: `Only feasible modelled option: ${best.name}`,
      text: `${best.name} is the only alternative that removes ${label}'s modelled shortage: no car is denied parking with ${n0(added(best))} added spaces usable here.${untestedNote} ${QUALIFIER}`,
      ...headOf(best) };
  }
  // 3 — several.
  if (cleanResolvers.length > 1) {
    const sorted = [...cleanResolvers].sort((a, b) => added(a) - added(b) || a.id.localeCompare(b.id));
    const fewest = sorted.filter(c => added(c) === added(sorted[0]));
    const efficient = fewest.length === 1 ? fewest[0] : null;
    return { kind: 'FEASIBLE', tone: 'ok', options: sorted.map(c => c.id), fewest: efficient?.id ?? null,
      headline: `Feasible options: ${list(sorted.map(short))}`,
      text: `${list(sorted.map(c => c.name))} each remove ${label}'s modelled shortage under the same demand, adding ${list(sorted.map(c => `${short(c)} ${n0(added(c))}`))} usable spaces. ${efficient ? `${efficient.name} is the most capacity-efficient: it needs the fewest added spaces. That is not a cost comparison.` : 'They need the same number of added spaces; the model does not separate them.'}${untestedNote} ${QUALIFIER}`,
      ...headOf(efficient ?? sorted[0]) };
  }
  if (untestable.length) {
    return { kind: 'INSUFFICIENT', tone: 'warn', headline: 'Not enough evidence to recommend a design',
      needs: ['Garage assignments or published capacities for the untested demand'],
      text: `${list(untestable.map(c => c.name))} show no shortage at ${label}, but only while some demand cannot be tested (no garage assigned, or a garage with no published capacity). Resolve that data gap before choosing.` };
  }

  // 4 — none resolves it.
  const better = c => c.turnedAway < baseCard.turnedAway || c.maxShortage < baseCard.maxShortage || c.shortageIntervals < baseCard.shortageIntervals;
  const order = (a, b) => a.turnedAway - b.turnedAway || a.maxShortage - b.maxShortage || a.shortageIntervals - b.shortageIntervals || added(a) - added(b);
  const reducers = alts.filter(better).sort(order);
  if (!reducers.length) {
    const why = alts.map(c => (added(c) > 0 ? `${short(c)} adds ${n0(added(c))} usable spaces but still leaves ${n0(c.maxShortage)} unmet` : `${short(c)} adds no spaces these terminals can use`));
    return { kind: 'NONE', tone: 'bad', headline: `No design reduces ${label}'s shortage`,
      text: `None of the alternatives changes ${label}'s modelled shortage of ${n0(baseCard.maxShortage)} spaces: ${list(why)}. Edit a design's capacity or terminal access.` };
  }
  const [best, next] = reducers;
  if (next && order(best, next) === 0 && added(best) === added(next)) {
    const tied = reducers.filter(c => order(c, best) === 0);
    return { kind: 'TIE', tone: 'warn', options: tied.map(c => c.id), headline: 'No alternative fully solves the problem',
      text: `${list(tied.map(c => c.name))} reduce ${label}'s unmet demand equally, from ${n0(baseCard.maxShortage)} to ${n0(best.maxShortage)} spaces; a shortage remains. ${QUALIFIER}`, ...headOf(best) };
  }
  return { kind: 'REDUCES', tone: 'warn', best: best.id, headline: `No alternative fully solves the problem — ${best.name} reduces it most`,
    text: `No alternative removes ${label}'s modelled shortage. ${best.name} reduces it most — it is only the best-performing of the modelled options, not a solution: cars denied ${n0(baseCard.turnedAway)} → ${n0(best.turnedAway)}, maximum unmet ${n0(baseCard.maxShortage)} → ${n0(best.maxShortage)}. ${QUALIFIER}`,
    ...headOf(best) };
}
