/**
 * Ask the Twin's TMC answers.
 *
 * The questions here are answered from `tmcService`, deterministically, before anything reaches a
 * language model. A model asked to look at raw incidents and decide which is riskiest would be
 * inventing an operational judgement, and two people asking the same question could get two
 * different answers. So the ranking, the factors and the mitigation are all computed; the wording
 * below only reports them.
 *
 * Pure: a question and an assessment in, an answer out.
 */
import { UPSTREAM_STATUS } from './upstreamResolver.js';
import { upstreamLabel } from './tmcResources.js';
import { TEMPORAL_MODES } from './temporalContext.js';

/** What the TMC screen offers before anything is selected. */
export const TMC_SUGGESTIONS = Object.freeze([
  'Which active incident has the highest secondary-incident risk?',
  'Which incidents need attention?',
  'Where is congestion building around active incidents?',
  'Show incidents with lane closures.',
  'Which incidents have High Operational Impact?',
]);

/** What it offers once an incident is open — the questions that are about THAT incident. */
export const TMC_INCIDENT_SUGGESTIONS = Object.freeze([
  'Why is this incident high risk?',
  'Is this a high-crash location?',
  'What types of crashes usually happen here?',
  'What factors are increasing the risk?',
  'Which cameras are upstream?',
  'Which DMS are upstream?',
  'Is congestion building upstream?',
  'What can we do to reduce the risk?',
  'How long has this incident been active?',
  'What is the Operational Impact here?',
]);

/**
 * The same questions in the past tense, for a past date.
 *
 * Not decoration: an operator reading "is congestion building upstream" while looking at September
 * could reasonably think they are being told about now. The tense is the only thing on the screen
 * that distinguishes a question about a recording from a question about the road.
 */
export const TMC_HISTORICAL_SUGGESTIONS = Object.freeze([
  'How many incidents occurred on this date?',
  'Which incident had the highest secondary-incident risk?',
  'Which incidents needed attention?',
  'Where was congestion building around incidents?',
  'Show incidents that had lane closures.',
  'Which incidents had High Operational Impact?',
]);

export const TMC_HISTORICAL_INCIDENT_SUGGESTIONS = Object.freeze([
  'Why was this incident high risk?',
  'Is this a high-crash location?',
  'What types of crashes usually happen here?',
  'What caused this accident?',
  'What data is missing?',
  'What factors were increasing the risk?',
  'Which cameras were upstream?',
  'Which DMS were upstream?',
  'Was there upstream congestion?',
  'What mitigation options were available?',
  'How long had this incident been active?',
  'What was the Operational Impact?',
]);

/** How each context type reads beside a count. */
const TYPE_NOUNS = Object.freeze({
  CLOSURE: 'closure', CONSTRUCTION: 'construction', CONGESTION: 'congestion', DISABLED: 'disabled vehicle',
});

/**
 * "8 congestion records", not "8 congestions".
 *
 * Congestion and construction are mass nouns, so an -s on either reads as a typo on an operational
 * screen. Counting the records instead is both correct English and literally what the number is.
 */
const MASS_NOUNS = new Set(['CONGESTION', 'CONSTRUCTION']);
export function countOfType(type, n) {
  const noun = TYPE_NOUNS[type] ?? String(type ?? '').toLowerCase();
  if (MASS_NOUNS.has(type)) return `${n} ${noun} record${n === 1 ? '' : 's'}`;
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * The questions each tab of the investigation workspace invites.
 *
 * Tied to what the operator is looking at: asking "what incident patterns are common here" while
 * reading the Response tab is a question about a different part of the screen. Every one of these
 * is answerable from the deterministic services — none of them needs the model to work anything out.
 */
export const TMC_TAB_SUGGESTIONS = Object.freeze({
  overview: Object.freeze([
    // "Why", not "how many": the counts are already on the screen.
    'Why does this incident require attention?',
    'What factors are increasing the risk?',
    'What was the weather at the incident time?',
    'What information is missing?',
  ]),
  history: Object.freeze([
    'Has this location shown similar problems before?',
    'Show me the historical incidents supporting this.',
    'What types of crashes usually happen here?',
    'What are the common historical contributing factors?',
    'Do crashes here happen more during peak periods?',
  ]),
  response: Object.freeze([
    'What mitigation opportunities are available?',
    'What could ACS investigate to improve this area?',
    'Which cameras are upstream?',
    'Which DMS are upstream?',
    'What information is missing?',
  ]),
});

/** The suggestions for the tab currently open, falling back to the incident-level list. */
export const tmcSuggestionsForTab = (tab, fallback) => TMC_TAB_SUGGESTIONS[tab] ?? fallback;

const has = (question, ...words) => {
  const text = String(question ?? '').toLowerCase();
  return words.every(word => text.includes(word));
};

/** Which TMC question, if any, this is. Matched on wording the suggestions actually use. */
export function parseTmcQuestion(question) {
  const text = String(question ?? '').toLowerCase().trim();
  if (!text) return null;
  if (has(text, 'highest') && (text.includes('secondary') || text.includes('risk'))) return 'HIGHEST_RISK';
  if (has(text, 'reduce') && text.includes('risk')) return 'MITIGATION';
  if (text.includes('mitigat')) return 'MITIGATION';
  if (has(text, 'could we have done') || has(text, 'what could we')) return 'MITIGATION';
  if ((has(text, 'why') && text.includes('risk')) || has(text, 'factors', 'risk')) return 'WHY_RISK';
  if (text.trim() === 'why' || text.trim() === 'why?') return 'WHY_RISK';
  if (has(text, 'camera') && text.includes('upstream')) return 'UPSTREAM_CAMERAS';
  if ((text.includes('dms') || text.includes('sign')) && text.includes('upstream')) return 'UPSTREAM_SIGNS';
  if (text.includes('congestion') && (text.includes('upstream') || text.includes('building'))) return 'UPSTREAM_CONGESTION';
  if (has(text, 'lane closure') || has(text, 'lane', 'closure')) return 'LANE_CLOSURES';
  if (text.includes('operational impact')) return 'HIGH_IMPACT';
  if (has(text, 'how long') && text.includes('active')) return 'DURATION';
  // Location history. The SPECIFIC patterns are matched before the general "crashes here", which
  // would otherwise swallow all of them.
  if (has(text, 'caused') || has(text, 'root cause') || has(text, 'what cause')) return 'ROOT_CAUSE';
  // The POC's headline question, and the one an operator actually asks.
  if (has(text, 'require') && text.includes('attention')) return 'WHY_RISK';
  if (has(text, 'why') && (text.includes('care') || text.includes('matter') || text.includes('attention'))) return 'WHY_RISK';
  if (has(text, 'show') && text.includes('historical')) return 'LOCATION_HISTORY';
  if (has(text, 'shown similar') || (has(text, 'similar') && text.includes('before'))) return 'LOCATION_HISTORY';
  if (has(text, 'investigate') || has(text, 'opportunit') || has(text, 'improve this area')) return 'OPPORTUNITY';
  if (has(text, 'missing') || has(text, 'what data')) return 'DATA_GAPS';
  if ((has(text, 'types') || has(text, 'kind')) && text.includes('crash')) return 'LOCATION_CRASH_TYPES';
  if (has(text, 'rear-end') || has(text, 'rear end')) return 'LOCATION_CRASH_TYPES';
  if (has(text, 'contributing')) return 'LOCATION_FACTORS';
  if ((has(text, 'peak') || has(text, 'time of day')) && /crash|happen/.test(text)) return 'LOCATION_TIME';
  if (has(text, 'weather') && /common|crashes here|historical/.test(text)) return 'LOCATION_WEATHER';
  if (text.includes('weather')) return 'INCIDENT_WEATHER';
  if (has(text, 'high-crash') || has(text, 'high crash') || (has(text, 'this location') && /concern|risk|crash|safe/.test(text))) return 'LOCATION_HISTORY';
  if (has(text, 'crashes') && /near here|previously|before|happened here|here\?|here$/.test(text)) return 'LOCATION_HISTORY';
  // The date-level question, which only a historical assessment can answer.
  if (has(text, 'how many') && text.includes('incident')) return 'DATE_COUNT';
  if (has(text, 'what happened') || has(text, 'incidents', 'this date') || has(text, 'incidents', 'that date')) return 'DATE_COUNT';
  if (has(text, 'incidents', 'attention') || has(text, 'need', 'attention') || has(text, 'needed', 'attention')) return 'NEEDS_ATTENTION';
  return null;
}

const place = incident => incident.sectionLabel ?? `I-595 ${incident.carriageway === 'WB_GENERAL' ? 'Westbound' : incident.carriageway === 'EB_GENERAL' ? 'Eastbound' : 'carriageway unresolved'}`;

const factorLines = risk => (risk.contributors ?? risk.factors.filter(f => f.present))
  .map(f => `• ${f.label}${f.detail ? ` — ${f.detail}` : ''}`);
const unavailableLines = risk => risk.unavailableFactors.map(f => `• ${f.label} — ${f.reason.toLowerCase()}`);

/**
 * Answer a TMC question from an assessment.
 *
 * @returns {{answer: string, actions: object[], incidentId: string|null}|null}
 */
export function answerTmcQuestion(intent, assessed, { selected = null } = {}) {
  if (!intent) return null;
  const historical = assessed?.historical === true || assessed?.when?.mode === TEMPORAL_MODES.HISTORICAL;
  const when = assessed?.when?.label ?? null;
  /** Every historical answer says so first, so a recording can never read as the live road. */
  const head = text => (historical && when ? `HISTORICAL ANALYSIS\n${when}\n\n${text}` : text);
  const dated = historical && assessed?.when?.timestamp == null;
  const none = {
    answer: historical && when
      ? head(dated
        ? `No I-595 incidents were recorded on ${when}.`
        : `No I-595 incidents were active at ${when}.`)
      : 'No active I-595 incidents are currently available to assess for secondary-incident risk.',
    actions: [], incidentId: null,
  };

  // "How many happened that day" — the question the date mode exists to answer. It reports the
  // count the screen is showing, and the other record types alongside it so a small number of
  // incidents is not mistaken for a quiet corridor.
  if (intent === 'DATE_COUNT') {
    if (!historical) {
      const live = assessed?.counts?.activeIncidents ?? 0;
      return {
        incidentId: null, actions: [],
        answer: live
          ? `${live} I-595 incident${live === 1 ? ' is' : 's are'} currently active. Switch Mode to Historical and pick a date to count a past day.`
          : 'No I-595 incidents are currently active. Switch Mode to Historical and pick a date to count a past day.',
      };
    }
    const count = assessed?.counts?.activeIncidents ?? 0;
    if (!count) return none;
    // "Occurred on" is only true of the ones reported that day. An incident that ran into the date
    // from an earlier one is reported as what it was: still on the corridor.
    const carried = (assessed?.ranked ?? []).filter(e => e.startedOnDate === false).length;
    const headline = carried === 0
      ? `${count} I-595 incident${count === 1 ? '' : 's'} occurred on ${when}.`
      : `${count} I-595 incident${count === 1 ? ' was' : 's were'} on the corridor on ${when} — `
        + `${count - carried} reported that day, ${carried} still running from earlier.`;
    const byType = assessed?.counts?.byType ?? {};
    const others = Object.entries(byType)
      .filter(([type]) => type !== 'INCIDENT')
      .sort((a, b) => b[1] - a[1])
      .map(([type, n]) => `• ${countOfType(type, n)}`);
    const list = (assessed?.ranked ?? []).map(e => `• ${e.incident.id} — ${place(e.incident)} — ${e.risk.levelLabel} risk`);
    return {
      incidentId: null, actions: [],
      answer: head([
        headline,
        list.length ? list.join('\n') : null,
        others.length ? `Also recorded that day:\n${others.join('\n')}` : null,
        'Select an incident to analyse the conditions around its own time.',
      ].filter(Boolean).join('\n\n')),
    };
  }

  if (intent === 'HIGHEST_RISK' || intent === 'NEEDS_ATTENTION') {
    const top = assessed?.ranked?.[0];
    if (!top) return none;
    const { incident, risk, mitigation, resources } = top;
    const tied = (assessed.tied ?? []).length > 1
      ? `\n\nTied on score with ${assessed.tied.slice(1).map(e => e.incident.id).join(', ')} — both are the highest.`
      : '';
    return {
      incidentId: incident.id,
      answer: head([
        `Highest secondary-incident risk:\n\n${incident.id}\n${place(incident)}`,
        `Risk: ${risk.levelLabel}`,
        factorLines(risk).length ? `Contributing factors:\n${factorLines(risk).join('\n')}` : 'No contributing factors were detected in the connected data.',
        mitigation.length ? `Potential mitigation:\n${mitigation.map(m => `• ${m.text}`).join('\n')}` : null,
        `Unavailable${historical ? ' historical information' : ''}:\n${unavailableLines(risk).join('\n')}`,
      ].filter(Boolean).join('\n\n')) + tied,
      actions: buildActions(top, resources),
    };
  }

  const entry = selected ?? assessed?.ranked?.[0];
  if (!entry) return none;
  const { incident, risk, upstream, upstreamCongestion, impactLevel, resources, mitigation } = entry;
  const history = entry.locationHistory ?? null;
  const noHistory = `No location safety history has been computed for ${incident.id}. Open the incident to analyse its location.`;
  const pct = share => `${Math.round(share * 100)}%`;
  const patternCaveat = 'These are recurring patterns at this location. They do not establish the cause of this incident.';

  switch (intent) {
    /**
     * The one question where a wrong answer is actively harmful.
     *
     * `root_cause` is empty on all 178 records in the connected register, so there IS no reported
     * cause to give. Conditions around the incident are offered instead, clearly labelled as
     * conditions, and historical patterns are never used to manufacture a cause.
     */
    case 'ROOT_CAUSE': {
      const reported = incident.raw?.attributes?.root_cause ?? incident.event?.raw?.attributes?.root_cause ?? null;
      if (reported && String(reported).trim()) {
        return { incidentId: incident.id, actions: buildActions(entry, resources),
          answer: head(`The reported cause in the crash record is: ${String(reported).trim()}.`) };
      }
      const conditions = [
        ...risk.contributors.map(f => `• ${f.label}${f.detail ? ` — ${f.detail}` : ''}`),
        risk.weather ? `• Weather at the incident time — ${risk.weather.condition ?? 'recorded'}` : null,
      ].filter(Boolean);
      return {
        incidentId: incident.id, actions: buildActions(entry, resources),
        answer: head([
          `The connected crash record does not provide a confirmed primary cause for ${incident.id}.`,
          'The historical incident register publishes no reported-cause field for any of its records.',
          conditions.length ? `Observed conditions around the incident included:\n${conditions.join('\n')}` : null,
          'These are conditions recorded around the incident. They are not a determination of cause.',
        ].filter(Boolean).join('\n\n')),
      };
    }

    /** The reading already attached to this incident. Never re-derived, never current weather. */
    case 'INCIDENT_WEATHER': {
      const w = risk.weather;
      if (!w) {
        return { incidentId: incident.id, actions: [],
          answer: head(risk.weatherState === 'unavailable'
            ? `Historical weather for ${incident.id} is unavailable, so conditions were not assessed.`
            : `Weather has not been retrieved for ${incident.id} yet.`) };
      }
      const u = w.units ?? {};
      const line = (name, value) => (value == null ? null : `• ${name}: ${value}`);
      return {
        incidentId: incident.id, actions: [],
        answer: head([
          `Weather at ${incident.id}:`,
          [line('Condition', w.condition),
            line('Precipitation', Number.isFinite(w.precipitation) ? `${w.precipitation.toFixed(1)} ${u.precipitation ?? 'mm'}` : null),
            line('Visibility', Number.isFinite(w.visibility) ? `${(w.visibility / 1000).toFixed(1)} km` : null),
            line('Wind', Number.isFinite(w.windSpeed) ? `${Math.round(w.windSpeed)} ${u.windSpeed ?? 'km/h'}` : null),
            line('Temperature', Number.isFinite(w.temperature) ? `${Math.round(w.temperature)} ${u.temperature ?? '°C'}` : null),
          ].filter(Boolean).join('\n'),
          `Source: ${w.source ?? 'Open-Meteo'}, reading for ${w.matchedWeatherTime}, the nearest hour to ${w.requestedIncidentTime}.`,
          'A contributing condition recorded around the incident, not a stated cause.',
        ].join('\n\n')),
      };
    }

    /**
     * "Is this a high-crash location?"
     *
     * The honest answer leads with what cannot be confirmed. The register's positions are the
     * damaged ASSET's, not surveyed crash coordinates, so an elevated concentration of records is
     * exactly that — and calling it a crash hotspot would be the application asserting something
     * its source does not support.
     */
    /** What ACS might look into. Separate from risk and from mitigation, deliberately. */
    case 'OPPORTUNITY': {
      const opportunity = entry.opportunity;
      if (!opportunity) {
        return { incidentId: incident.id, actions: [],
          answer: head(`Nothing in the connected data for ${incident.id} points to a recurring issue worth investigating. `
            + 'An opportunity is only reported when the evidence supports one.') };
      }
      return {
        incidentId: incident.id, actions: historyActions(entry),
        answer: head([
          opportunity.summary,
          `Supporting evidence:\n${opportunity.evidence.map(line => `• ${line}`).join('\n')}`,
          `Limitations:\n${opportunity.limitations.map(line => `• ${line}`).join('\n')}`,
        ].join('\n\n')),
      };
    }

    case 'LOCATION_HISTORY': {
      if (!history?.available) {
        return { incidentId: incident.id, actions: [], answer: head(history?.reason ?? noHistory) };
      }
      const c = history.concentration;
      const p = history.provenance ?? {};
      const top = history.crashTypes[0];
      const noun = p.recordNoun === 'crashes' ? 'crashes' : 'historical incident records';
      const elevated = ['ELEVATED', 'HIGH', 'VERY_HIGH'].includes(c.level);
      const headline = p.surveyedCrashGeometry
        ? (elevated
          ? `Yes — the connected crash records show a ${c.levelLabel.toLowerCase()} concentration near this location.`
          : `The connected crash records do not show an elevated concentration near this location.`)
        : (elevated
          ? 'The connected incident register shows an elevated concentration of historical records near this location, '
            + 'but I cannot confirm that this is a true crash hotspot because locations are derived from damaged assets '
            + 'rather than surveyed crash coordinates.'
          : 'The connected incident register does not show an elevated concentration of historical records near this location. '
            + 'Either way I cannot confirm a true crash picture here, because locations are derived from damaged assets '
            + 'rather than surveyed crash coordinates.');
      return {
        incidentId: incident.id, actions: [...historyActions(entry), ...buildActions(entry, resources)],
        answer: head([
          headline,
          `${history.totals.crashes} ${noun} were recorded within ${history.analysisWindow.distanceMeters} m of `
          + `${incident.id} in the ${history.analysisWindow.lookbackMonths} months before it`
          + `, of which ${p.confirmedCrashRecords ?? 0} carry a police report number.`,
          c.ratio == null
            ? `Concentration: ${c.levelLabel} — ${c.reason}`
            : `Concentration: ${c.levelLabel} — ${c.ratio}x the typical number of incident records in a `
              + `${history.analysisWindow.distanceMeters} m stretch of this corridor, which holds ${c.corridorBaseline}. `
              + 'That is a record-count comparison, not a validated crash rate: the connected data carries no traffic volume to normalise by.',
          `${history.totals.severeCrashes} involved a hospitalisation or fatality.`,
          top ? `Most common pattern: ${top.value} (${top.count} of ${top.of}, ${pct(top.share)}).` : null,
          `Location source: ${p.locationSourceLabel ?? 'unknown'} · spatial confidence ${String(p.spatialConfidence ?? 'LOW').toLowerCase()} · `
          + `matching ${history.matchBasis.label.toLowerCase()}${history.matchBasis.reason ? ` (${history.matchBasis.reason.toLowerCase()})` : ''}. `
          + 'Its contribution to the risk score is weighted down for that reason.',
        ].filter(Boolean).join('\n\n')),
      };
    }

    case 'LOCATION_CRASH_TYPES': {
      if (!history?.available || !history.crashTypes.length) {
        return { incidentId: incident.id, actions: [], answer: head(history?.available
          ? 'Crash type is not available from the connected historical crash data for this location.' : (history?.reason ?? noHistory)) };
      }
      return {
        incidentId: incident.id, actions: historyActions(entry),
        answer: head([`Historical ${history.provenance?.recordNoun === 'crashes' ? 'crash' : 'incident'} patterns within ${history.analysisWindow.distanceMeters} m of ${incident.id}:`,
          history.crashTypes.map(t => `• ${t.value} — ${t.count} of ${t.of} (${pct(t.share)})`).join('\n'),
          patternCaveat].join('\n\n')),
      };
    }

    case 'LOCATION_FACTORS': {
      if (!history?.available || !history.contributingFactors.length) {
        return { incidentId: incident.id, actions: [], answer: head(history?.available
          ? 'Contributing circumstances are not available from the connected historical crash data for this location.'
          : (history?.reason ?? noHistory)) };
      }
      return {
        incidentId: incident.id, actions: [],
        answer: head([
          `Recurring contributing circumstances near ${incident.id}:`,
          history.contributingFactors.map(f => `• ${f.value} — ${f.count} of ${f.of} (${pct(f.share)})`).join('\n'),
          'These are contributing circumstances recorded with past incidents, not a reported cause — the connected register publishes no reported-cause field.',
          patternCaveat].join('\n\n')),
      };
    }

    case 'LOCATION_TIME': {
      if (!history?.available || !history.timePatterns.length) {
        return { incidentId: incident.id, actions: [], answer: head(history?.reason ?? noHistory) };
      }
      const here = history.selectedTimeBucket;
      return {
        incidentId: incident.id, actions: [],
        answer: head([
          `Historical crash periods within ${history.analysisWindow.distanceMeters} m of ${incident.id}:`,
          history.timePatterns.map(t => `• ${t.value} — ${t.count} of ${t.of} (${pct(t.share)})`).join('\n'),
          here ? `This incident falls in the ${here.label} period${here.isMostCommon ? ', the most common historical crash period at this location' : ''} (${pct(here.share)} of previous crashes).` : null,
          patternCaveat].filter(Boolean).join('\n\n')),
      };
    }

    case 'LOCATION_WEATHER': {
      if (!history?.available || !history.weatherPatterns.length) {
        return { incidentId: incident.id, actions: [], answer: head(history?.available
          ? 'Weather is not recorded with the connected historical crash data for this location.' : (history?.reason ?? noHistory)) };
      }
      const wet = history.weatherPatterns.filter(w => /rain|storm/i.test(w.value)).reduce((t, w) => t + w.share, 0);
      return {
        incidentId: incident.id, actions: [],
        answer: head([
          `Weather recorded with previous crashes within ${history.analysisWindow.distanceMeters} m of ${incident.id}:`,
          history.weatherPatterns.map(w => `• ${w.value} — ${w.count} of ${w.of} (${pct(w.share)})`).join('\n'),
          wet > 0 ? `${pct(wet)} were recorded in wet conditions. This is how often wet weather was present, not a measure of what it caused.` : null,
          'This is the weather field stored on each historical record, not an independent measurement.',
        ].filter(Boolean).join('\n\n')),
      };
    }

    case 'DATA_GAPS':
      return {
        incidentId: incident.id, actions: [],
        answer: head([
          `Data confidence for ${incident.id}: ${risk.confidence.label} — ${risk.confidence.evaluated} factors evaluated, `
          + `${risk.confidence.unknown + risk.unavailableFactors.length} unavailable.`,
          'Not available:',
          [...risk.unknownFactors.map(f => `• ${f.label} — ${f.detail ?? 'unknown'}`),
            ...risk.unavailableFactors.map(f => `• ${f.label} — ${f.reason.toLowerCase()}`)].join('\n'),
          'Missing information is reported as unknown. It is never scored as though conditions were benign.',
        ].join('\n\n')),
      };

    case 'WHY_RISK':
      return {
        incidentId: incident.id,
        answer: head([`${incident.id} ${historical ? 'was' : 'is'} ${risk.levelLabel} secondary-incident risk — ${risk.score} out of 100.`,
          factorLines(risk).length ? `What contributed:\n${factorLines(risk).join('\n')}` : 'No contributing factors were detected.',
          `Data confidence: ${risk.confidence.label} (${risk.confidence.evaluated} factors evaluated, ${risk.confidence.unknown + risk.unavailableFactors.length} unavailable).`,
          `Not available:\n${unavailableLines(risk).join('\n')}`,
          'This is a rule-based indicator from the connected data, not a prediction.'].join('\n\n')),
        actions: buildActions(entry, resources),
      };
    case 'MITIGATION':
      return {
        incidentId: incident.id,
        answer: head([`Potential mitigation actions${historical ? ' available at that time' : ''} for ${incident.id}:`,
          mitigation.map((m, i) => `${i + 1}. ${m.text}`).join('\n'),
          'These are suggestions for an operator. Nothing here is carried out automatically.'].join('\n\n')),
        actions: buildActions(entry, resources),
      };
    case 'UPSTREAM_CAMERAS':
      return {
        incidentId: incident.id,
        answer: resources.camera
          ? `Nearest upstream camera for ${incident.id} is ${resources.camera.id}, ${upstreamLabel(resources.camera)}.\n\nProximity only — this does not confirm the camera is showing the incident.`
          : `No upstream camera resolved for ${incident.id}${upstream.status === UPSTREAM_STATUS.RESOLVED ? ' within range.' : ` — ${String(upstream.reason).toLowerCase()}.`}`,
        actions: buildActions(entry, resources),
      };
    case 'UPSTREAM_SIGNS':
      return {
        incidentId: incident.id,
        answer: resources.sign
          ? `Nearest upstream sign for ${incident.id} is ${resources.sign.id}, ${upstreamLabel(resources.sign)}.\n\nThe feed does not publish sign messages, so this cannot confirm a warning is in place for this incident.`
          : `No upstream sign resolved for ${incident.id}${upstream.status === UPSTREAM_STATUS.RESOLVED ? ' within range.' : ` — ${String(upstream.reason).toLowerCase()}.`}`,
        actions: buildActions(entry, resources),
      };
    case 'UPSTREAM_CONGESTION':
      return {
        incidentId: incident.id,
        answer: upstream.status !== UPSTREAM_STATUS.RESOLVED
          ? `Upstream conditions cannot be assessed for ${incident.id} — ${String(upstream.reason).toLowerCase()}.`
          : upstreamCongestion.length
            ? `${upstreamCongestion.length} congestion event${upstreamCongestion.length === 1 ? '' : 's'} reported upstream of ${incident.id}, on ${upstream.sections.map(s => s.sectionLabel ?? s.sectionId).join(' and ')}.`
            : `No congestion is currently reported upstream of ${incident.id}.`,
        actions: buildActions(entry, resources),
      };
    case 'LANE_CLOSURES': {
      const blocking = (assessed.assessments ?? []).filter(e => e.incident.blocksTravelLanes);
      return {
        incidentId: null,
        answer: blocking.length
          ? `${blocking.length} active incident${blocking.length === 1 ? '' : 's'} with lanes blocked:\n${blocking.map(e => `• ${e.incident.id} — ${place(e.incident)} (${e.risk.levelLabel} risk)`).join('\n')}`
          : 'No active incidents currently report blocked travel lanes. Lane impact is only known where the source states it.',
        actions: [],
      };
    }
    case 'HIGH_IMPACT': {
      const high = (assessed.assessments ?? []).filter(e => e.impactLevel === 'HIGH' || e.impactLevel === 'SEVERE');
      return {
        incidentId: null,
        answer: high.length
          ? `${high.length} active incident${high.length === 1 ? '' : 's'} on a section at High or Severe Operational Impact:\n${high.map(e => `• ${e.incident.id} — ${place(e.incident)} (${e.impactLevel})`).join('\n')}`
          : 'No active incidents are on a section currently at High or Severe Operational Impact.',
        actions: [],
      };
    }
    case 'DURATION':
      return {
        incidentId: incident.id,
        answer: incident.activeMinutes == null
          ? `${incident.id} has no published start time, so its duration cannot be stated.`
          : `${incident.id} has been active for ${incident.activeMinutes} minutes, on ${place(incident)}.`,
        actions: buildActions(entry, resources),
      };
    default:
      return null;
  }
}

/** The synchronised map actions an answer offers. Only ones that have somewhere to go. */
/**
 * Structured actions an answer may offer.
 *
 * The model never touches the map. It chooses between these, and the chat layer validates each one
 * against the deterministic context before executing it — so an action can only ever point at
 * something the assessment actually resolved.
 */
export const TWIN_ACTIONS = Object.freeze({
  SELECT_INCIDENT: 'SELECT_INCIDENT',
  FOCUS_AFFECTED_SECTION: 'FOCUS_AFFECTED_SECTION',
  FOCUS_RESOURCE: 'FOCUS_RESOURCE',
  SHOW_HISTORY: 'SHOW_HISTORY',
  FILTER_HISTORY: 'FILTER_HISTORY',
  CLEAR_HISTORY_FILTER: 'CLEAR_HISTORY_FILTER',
});

function buildActions(entry, resources) {
  const actions = [{ id: 'incident', type: TWIN_ACTIONS.SELECT_INCIDENT, label: 'View incident', incidentId: entry.incident.id }];
  if (resources?.camera) {
    actions.push({ id: 'camera', type: TWIN_ACTIONS.FOCUS_RESOURCE, resourceType: 'camera',
      resourceId: resources.camera.id, label: `View ${resources.camera.id}`, resource: resources.camera });
  }
  if (resources?.sign) {
    actions.push({ id: 'sign', type: TWIN_ACTIONS.FOCUS_RESOURCE, resourceType: 'sign',
      resourceId: resources.sign.id, label: `View ${resources.sign.id}`, resource: resources.sign });
  }
  if (entry.incident.segmentId) {
    actions.push({ id: 'section', type: TWIN_ACTIONS.FOCUS_AFFECTED_SECTION, label: 'Show affected section', incidentId: entry.incident.id });
  }
  return actions;
}

/** The actions that make a location-history answer spatial. Only offered when there is history. */
function historyActions(entry) {
  const history = entry.locationHistory;
  if (!history?.available || !history.totals.crashes) return [];
  const actions = [{ id: 'show-history', type: TWIN_ACTIONS.SHOW_HISTORY,
    label: `Show ${history.totals.crashes} on map`, incidentId: entry.incident.id }];
  const top = history.crashTypes?.[0];
  if (top) {
    actions.push({ id: `filter-${top.value}`, type: TWIN_ACTIONS.FILTER_HISTORY,
      filterType: 'type', filterValue: top.value, label: `Show ${top.value.toLowerCase()} (${top.count})`, incidentId: entry.incident.id });
  }
  return actions;
}
