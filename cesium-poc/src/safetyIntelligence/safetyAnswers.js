/**
 * Deterministic answers about the Safety Intelligence screen.
 *
 * Asked "where are the worst locations", an operator must get the SAME answer the screen shows,
 * every time, with the same caveats. So these answers are written from the screen's own context
 * object rather than by a model reading records and deciding — and each one carries the caveat that
 * belongs to the number, not a tidier version of it.
 *
 * A question this module does not recognise returns null, and the chat routes on as before.
 */

/** Suggestions offered while the screen is open. Each maps to an intent below. */
export const SAFETY_SUGGESTIONS = Object.freeze([
  'Why is this section high risk?',
  'What accident patterns occur here?',
  'Which nearby assets have relevant defects?',
  'What interventions should we consider?',
  'What can this screen not tell me?',
]);

const INTENTS = Object.freeze([
  // Asked first: with something selected, "why is this high risk" is a question about THAT, and
  // answering it from the corridor would answer a question nobody asked.
  //
  // "What accident patterns occur here?" is one of the questions this screen SUGGESTS, and it
  // matched nothing — so a suggested question fell through to the language model, which is the one
  // route these answers exist to avoid. Patterns and "here" both route to the selection.
  { id: 'selected', test: /(why is this|this (section|segment|location|place|spot)|what happened here|about (this|here)|(accident|crash|incident|collision) patterns?|patterns? (occur|happen)|(occur|happen)s? here)/i },
  { id: 'interventions', test: /(intervention|what should we|recommend|what to do|mitigat)/i },
  // Word boundaries matter here: an unanchored /rate/ matched "concent-rate" and sent every
  // question about concentrations to the section ranking.
  { id: 'sections', test: /(\bsections?\b|\bsegments?\b|which part|per 100|\bvmt\b|\bexposure\b|\brates?\b)/i },
  { id: 'hotspots', test: /(hotspot|concentrat|worst (location|place|spot)|where.*(record|crash|incident)s?\b)/i },
  { id: 'queue', test: /(priorit|queue|what should i look at|top of the list|most urgent)/i },
  { id: 'secondary', test: /secondary/i },
  { id: 'assets', test: /(defect|work order|overdue|asset safety|mttr|repair)/i },
  { id: 'hazards', test: /(hazard|debris|road ranger|patrol|clear zone)/i },
  { id: 'gaps', test: /(cannot|can.?t|not available|unavailable|missing|what.*need|limitation|rate per)/i },
  { id: 'overview', test: /(safety (record|overview|summary)|how many (incident|crash|record))/i },
]);

export const parseSafetyQuestion = question => INTENTS.find(intent => intent.test.test(String(question ?? '')))?.id ?? null;

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * @param {string} intent from parseSafetyQuestion()
 * @param {object} context from the workspace's context()
 * @returns {{answer: string, entryId?: string, hotspotId?: string}|null}
 */
export function answerSafetyQuestion(intent, context) {
  if (!intent || !context) return null;
  const period = context.provenance
    ? `${context.provenance.firstMonth} to ${context.provenance.lastMonth}` : 'the selected range';
  const standing = context.provenance?.statisticalStanding ?? '';

  switch (intent) {
    case 'hotspots': {
      const top = context.concentrations.slice(0, 5);
      if (!top.length) return { answer: 'No concentration of records was found at the current clustering settings.' };
      return {
        hotspotId: top[0].id,
        answer: [
          `${plural(context.concentrations.length, 'concentration')} of incident records on the corridor, `
            + `from ${context.records} records (${period}). The largest:`,
          ...top.map((cluster, index) => `${index + 1}. ${cluster.label} — ${plural(cluster.records, 'record')}, `
            + `${cluster.severeRecords} with injury or worse, `
            + `${Math.round(cluster.confirmationRate * 100)}% with a police report number`
            + (cluster.dominantType ? `, mostly ${cluster.dominantType.toLowerCase()}` : '')),
          '',
          context.hotspotCaveat,
          standing,
        ].join('\n'),
      };
    }
    case 'queue': {
      const top = context.queue.slice(0, 5);
      if (!top.length) return { answer: 'The priority queue is empty for the current selection.' };
      return {
        entryId: top[0].id,
        answer: [
          'The priority queue, highest urgency first:',
          ...top.map((entry, index) => `${index + 1}. ${entry.title} — ${entry.urgency.toLowerCase()}, `
            + `${entry.domain.toLowerCase()}, ${entry.counted}. ${entry.rule}`),
          '',
          context.queueMethodology.noCompositeScore,
        ].join('\n'),
      };
    }
    case 'secondary':
      return {
        answer: [
          `${plural(context.secondary.observedRecords, 'record')} of ${context.records} carry a `
            + 'secondary-collision category.',
          context.secondary.caveat,
          context.secondary.modelledElevated == null
            ? 'The TMC’s secondary-risk model has no live incident to score at the moment, which is an '
              + 'absence of live incidents rather than a risk of zero.'
            : `Separately, the TMC’s model currently puts ${context.secondary.modelledElevated} LIVE `
              + 'incident(s) at elevated risk.',
          context.secondary.distinction,
        ].join('\n'),
      };
    case 'assets': {
      const asset = context.assetSafety;
      return {
        answer: [
          `${plural(asset.openDefects, 'open work order')} on safety-relevant assets, of `
            + `${asset.workOrders} read.`,
          asset.targetsPublished
            ? `${asset.overdue} are open beyond the repair-time target published for their asset `
              + `category, measured against ${asset.withTarget} work orders that have one.`
            : 'No repair-time targets are published for these categories, so nothing is reported as '
              + 'overdue — age is reported without a target.',
          asset.mttrDays == null
            ? 'Mean time to repair cannot be calculated: no closed work order carries both an open and '
              + 'a close date.'
            : `Mean time to repair is ${asset.mttrDays} days across ${asset.closedWithDates} closed `
              + 'work orders with both dates.',
        ].join('\n'),
      };
    }
    case 'hazards':
      return {
        answer: [
          `${plural(context.hazards.findings, 'hazard finding')} across ${context.hazards.locations} `
            + 'location(s), from the roadway and safety inspection forms.',
          context.hazards.caveat,
          'No Road Ranger dataset exists on this instance, so response times, patrol coverage and '
            + 'hazards per patrol-hour cannot be reported at all.',
        ].join('\n'),
      };
    case 'gaps':
      return {
        answer: [
          'What this screen cannot calculate, and what each would need:',
          ...context.unavailable.map(kpi => `• ${kpi.label} — ${kpi.requires}`),
          '',
          standing,
        ].join('\n'),
      };
    case 'selected': {
      if (!context.investigation) {
        return { answer: 'Nothing is selected, so there is no location to describe. Choose a section, '
          + 'a concentration, an asset or a hazard on the map or in the priority list first.' };
      }
      const investigation = context.investigation;
      const summary = investigation.summary;
      return {
        answer: [
          `${investigation.label}: ${summary.records} incident records, ${summary.severeRecords} with `
            + `injury or worse${summary.fatalRecords ? `, ${summary.fatalRecords} fatal` : ''}.`,
          summary.perHundredMillionVmt != null
            ? `That is ${summary.perHundredMillionVmt} recorded incidents per 100 million vehicle-miles, `
              + `against ${context.sections?.length ?? 0} sections on this corridor.`
            : 'No exposure is published for this stretch, so no rate can be given for it.',
          investigation.accidentPatterns.length
            ? `Most often: ${investigation.accidentPatterns.slice(0, 3)
              .map(row => `${row.label.toLowerCase()} (${row.count})`).join(', ')}.`
            : '',
          investigation.secondaryLabelled
            ? `${investigation.secondaryLabelled} record(s) carry a secondary-collision category. `
              + investigation.verifiedPairsNote
            : '',
          investigation.openDefects
            ? `${investigation.openDefects} open work order(s) on safety-relevant assets sit here.` : '',
          investigation.hazardFindings
            ? `${investigation.hazardFindings} hazard finding(s) from inspections.` : '',
          investigation.record
            ? `One record is open beside this stretch: ${investigation.record.type}, `
              + `${investigation.record.severity}, ${investigation.record.when}. `
              + investigation.record.scopeNote
            : '',
          investigation.locationConfidence,
        ].filter(Boolean).join('\n'),
      };
    }
    case 'interventions': {
      const items = context.investigation?.recommendations ?? [];
      if (!items.length) {
        return { answer: 'Nothing at the current selection meets the evidence threshold for a '
          + 'recommendation. Select a section or a concentration to see candidates for it.' };
      }
      return {
        answer: [
          `${items.length} candidate action(s) for ${context.investigation.label}:`,
          ...items.map((item, index) => `${index + 1}. ${item.concern}\n   Evidence: ${item.evidence}`
            + `\n   Action: ${item.action}\n   Owner: ${item.owner} · ${item.urgency} · ${item.confidence}`
            + (item.caveat ? `\n   Caveat: ${item.caveat}` : '')),
          '',
          'These are candidates for review. No reduction in incidents is predicted for any of them.',
        ].join('\n'),
      };
    }
    case 'sections': {
      const sections = context.sections ?? [];
      if (!sections.length) return { answer: 'No corridor sections are loaded.' };
      const ranked = [...sections].sort((a, b) =>
        (b.perHundredMillionVmt ?? -1) - (a.perHundredMillionVmt ?? -1));
      return {
        answer: [
          'Corridor sections, by recorded incidents per 100 million vehicle-miles:',
          ...ranked.map((section, index) => `${index + 1}. ${section.label} — `
            + `${section.perHundredMillionVmt ?? '—'} (${section.records} records, AADT `
            + `${section.aadt?.toLocaleString('en-US') ?? 'unknown'})`),
          '',
          context.exposureAssumptions?.countNote ?? '',
          context.exposureAssumptions?.aadtNote ?? '',
        ].filter(Boolean).join('\n'),
      };
    }
    default:
      return {
        answer: [
          `${context.records} incident records, ${period}, from the corridor's incident register.`,
          `${context.concentrations.length} concentration(s) of records, `
            + `${context.secondary.observedRecords} categorised as secondary, `
            + `${context.assetSafety.openDefects} open safety-related work orders, `
            + `${context.hazards.findings} hazard findings from inspections.`,
          context.provenance.locationBasis,
          standing,
        ].join('\n'),
      };
  }
}
