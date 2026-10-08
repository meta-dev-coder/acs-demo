/**
 * What the twin makes of one incident, in sentences.
 *
 * Everything else in the TMC produces facts: a score, a list of factors, a concentration, a
 * reading. An operator still has to hold six of them in their head to decide whether an incident
 * deserves their attention. This writes that conclusion down, deterministically, from outputs that
 * already exist.
 *
 * It is NOT a model and NOT a language model. Given the same assessment it produces the same words,
 * every time, and it can only say things the connected data supports. Its whole job is arrangement.
 *
 * The distinction it is most careful about is the one the rest of this screen already makes:
 *
 *   NONE            evaluated, and there was nothing        "no congestion reported upstream"
 *   KNOWN NEGATIVE  evaluated, and it added no risk         "no measurable rain"
 *   UNKNOWN         could not be evaluated                  "traffic speed is not published"
 *   UNRESOLVED      a prerequisite was missing              "the carriageway could not be determined"
 *
 * Collapsing any of those into the others is how a summary becomes reassuring about something it
 * never actually checked.
 *
 * Pure: an assessment in, strings out. No DOM, no Cesium, no fetching.
 */
import { UPSTREAM_STATUS } from './upstreamResolver.js';

/** The silos a conclusion can draw on, named as an operator would recognise them. */
export const EVIDENCE_SOURCES = Object.freeze({
  INCIDENT: Object.freeze({ id: 'incident', label: 'Incident record', source: 'DataConnect' }),
  HISTORY: Object.freeze({ id: 'history', label: 'Location history', source: 'DataConnect' }),
  WEATHER: Object.freeze({ id: 'weather', label: 'Weather at incident time', source: 'Open-Meteo' }),
  TRAFFIC: Object.freeze({ id: 'traffic', label: 'Upstream traffic', source: 'FL511 via DataConnect' }),
  ROADWAY: Object.freeze({ id: 'roadway', label: 'Road geometry', source: 'FDOT corridor sections' }),
  RESOURCES: Object.freeze({ id: 'resources', label: 'Camera and DMS', source: 'Corridor inventory' }),
});

const sentence = text => String(text ?? '').trim().replace(/\s+/g, ' ');
const joinList = items => {
  const list = items.filter(Boolean);
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
};

/** A contributor's label, trimmed to the phrase that reads inside a sentence. */
const driverPhrase = factor => sentence(String(factor.label)
  .replace(/^Lane closure or blockage$/i, 'the lane closure')
  .replace(/^Incident severity$/i, 'the incident severity')
  .replace(/^Time the incident has been active$/i, 'how long it has been running')
  .replace(/^Upstream congestion$/i, 'upstream congestion')
  .replace(/^Operational Impact of the affected section$/i, 'the operational impact of the section')
  .replace(/^Historical (incident|crash) concentration at this location.*$/i, 'the concentration of past records at this location')
  .replace(/ at incident time$/i, '')
  .toLowerCase());

/**
 * Which sources actually contributed to THIS incident's assessment.
 *
 * A source appears only when it produced something. A silo that was asked and could not answer is
 * listed as unavailable rather than left out, because "we looked and there was nothing" is itself
 * worth knowing — but it is never shown as having contributed.
 */
export function evidenceSources({ risk, locationHistory, upstream, resources } = {}) {
  const used = [];
  const add = (source, state, detail) => used.push({ ...source, state, detail });

  add(EVIDENCE_SOURCES.INCIDENT, 'used', 'Incident type, severity, lane impact and timing');

  if (locationHistory?.available) {
    add(EVIDENCE_SOURCES.HISTORY, 'used',
      `${locationHistory.totals.crashes} records within ${locationHistory.analysisWindow.distanceMeters} m`);
  } else if (locationHistory) {
    add(EVIDENCE_SOURCES.HISTORY, 'unavailable', sentence(locationHistory.reason));
  }

  if (risk?.weather) add(EVIDENCE_SOURCES.WEATHER, 'used', `Reading for ${risk.weather.matchedWeatherTime}`);
  else if (risk?.weatherState === 'unavailable') add(EVIDENCE_SOURCES.WEATHER, 'unavailable', 'No historical reading could be retrieved');

  if (upstream?.status === UPSTREAM_STATUS.RESOLVED) {
    add(EVIDENCE_SOURCES.TRAFFIC, 'used', 'Congestion records upstream of this incident');
    add(EVIDENCE_SOURCES.ROADWAY, 'used', 'Corridor sections used to resolve upstream');
  } else {
    add(EVIDENCE_SOURCES.TRAFFIC, 'unavailable', 'Upstream direction could not be determined');
    add(EVIDENCE_SOURCES.ROADWAY, 'unavailable', sentence(upstream?.reason) || 'Section could not be resolved');
  }

  if (resources?.camera || resources?.sign) {
    add(EVIDENCE_SOURCES.RESOURCES, 'used',
      [resources.camera && `camera ${resources.camera.id}`, resources.sign && `sign ${resources.sign.id}`].filter(Boolean).join(', '));
  } else {
    add(EVIDENCE_SOURCES.RESOURCES, 'unavailable', 'No upstream camera or sign resolved for this incident');
  }
  return Object.freeze(used.map(Object.freeze));
}

/**
 * Why this incident deserves attention — two to four sentences.
 *
 * Reads only `risk.contributors`, so a neutral condition can never appear as a reason. The things
 * that could NOT be assessed get their own sentence rather than being quietly omitted.
 */
export function buildIncidentInsight({ incident, risk, locationHistory, upstream } = {}) {
  if (!risk) return null;
  const drivers = [...(risk.contributors ?? [])]
    .filter(factor => factor.type !== 'HISTORICAL_LOCATION')
    .sort((a, b) => b.contribution - a.contribution);
  const history = (risk.contributors ?? []).find(factor => factor.type === 'HISTORICAL_LOCATION');

  const where = incident?.sectionLabel ?? (incident?.carriageway && incident.carriageway !== 'UNKNOWN'
    ? `I-595 ${incident.carriageway === 'WB_GENERAL' ? 'westbound' : 'eastbound'}` : 'I-595');
  const headline = `${risk.levelLabel} secondary-incident risk — ${risk.score} out of 100.`;

  const parts = [];
  parts.push(drivers.length
    ? `This incident carries ${article(risk.levelLabel)} ${risk.levelLabel.toLowerCase()} secondary-incident risk on ${where}, `
      + `driven primarily by ${joinList(drivers.slice(0, 3).map(driverPhrase))}.`
    : `This incident carries ${article(risk.levelLabel)} ${risk.levelLabel.toLowerCase()} secondary-incident risk on ${where}. `
      + 'Nothing in the connected data added to the score.');

  if (history && locationHistory?.available) {
    const c = locationHistory.concentration;
    const noun = locationHistory.provenance?.recordNoun === 'crashes' ? 'crash records' : 'incident records';
    parts.push(`Historical ${noun} are also concentrated around this location — ${c.levelLabel.toLowerCase()} `
      + `relative to comparable stretches of this corridor.`);
  }

  // What could not be assessed, named rather than left as a silence.
  const blind = [];
  if (upstream?.status !== UPSTREAM_STATUS.RESOLVED) {
    blind.push(`upstream conditions cannot be assessed because ${readableReason(upstream?.reason)}`);
  }
  if ((risk.unknownFactors ?? []).some(factor => factor.type === 'OPERATIONAL_IMPACT')) {
    blind.push('the operational impact of the section could not be resolved');
  }
  if (risk.weatherState === 'unavailable') blind.push('no weather reading could be retrieved for the incident time');
  if (blind.length) parts.push(`${capitalise(joinList(blind))}.`);

  return Object.freeze({
    headline,
    summary: parts.join(' '),
    primaryDrivers: Object.freeze(drivers.slice(0, 3).map(factor => Object.freeze({
      type: factor.type, label: factor.label, detail: factor.detail, contribution: factor.contribution,
    }))),
    supportingEvidence: Object.freeze([
      history ? Object.freeze({ type: history.type, label: history.label, detail: history.detail }) : null,
      risk.weather ? Object.freeze({ type: 'WEATHER', label: 'Weather at incident time', detail: risk.weather.condition }) : null,
    ].filter(Boolean)),
    limitations: Object.freeze(blind.map(capitalise)),
  });
}

/**
 * An internal reason phrase as a clause an operator would read.
 *
 * The resolver states reasons as labels ("Carriageway unresolved"), which read as a fragment inside
 * a sentence — "because carriageway unresolved". These are the same facts, written as English.
 */
function readableReason(reason) {
  const text = sentence(reason).toLowerCase();
  if (!text) return 'the direction of travel could not be determined';
  if (/carriageway/.test(text)) return 'the carriageway could not be determined for this incident';
  if (/section/.test(text)) return 'the corridor section could not be resolved';
  if (/confidence/.test(text)) return 'the location match was not confident enough to resolve a direction';
  return text;
}

const article = word => (/^[aeiou]/i.test(String(word)) ? 'an' : 'a');
const capitalise = text => (text ? text[0].toUpperCase() + text.slice(1) : text);

/**
 * What the location's own history says — one to three sentences.
 *
 * Carries the spatial caveat in the summary itself rather than relying on a footnote, because this
 * paragraph is the part most likely to be read aloud and quoted.
 */
export function buildHistoricalInsight(locationHistory) {
  if (!locationHistory) return null;
  if (!locationHistory.available) {
    return Object.freeze({ summary: sentence(locationHistory.reason), available: false, limitations: Object.freeze([]) });
  }
  const c = locationHistory.concentration;
  const p = locationHistory.provenance ?? {};
  const noun = p.recordNoun === 'crashes' ? 'crash records' : 'incident records';
  if (!locationHistory.totals.crashes) {
    return Object.freeze({
      available: true,
      summary: `No historical ${noun} were found within ${locationHistory.analysisWindow.distanceMeters} m of this incident `
        + `in the preceding ${locationHistory.analysisWindow.lookbackMonths} months. An absence of records is not evidence that the location is safe.`,
      limitations: Object.freeze([]),
    });
  }
  const parts = [];
  parts.push(c.ratio == null
    ? `${locationHistory.totals.crashes} historical ${noun} were recorded near this location, too few to compare against the corridor.`
    : `Historical ${noun} are concentrated around this location — ${locationHistory.totals.crashes} within `
      + `${locationHistory.analysisWindow.distanceMeters} m, ${c.ratio}× the typical concentration of records in a comparable corridor stretch.`);

  // Patterns, and ties reported as ties.
  const top = locationHistory.crashTypes?.[0];
  if (top) {
    const tied = locationHistory.crashTypes.filter(entry => entry.count === top.count);
    parts.push(tied.length > 1
      ? `${joinList(tied.map(entry => entry.value))} are equally the most common recorded patterns (${top.count} each).`
      : `${top.value} is the most commonly recorded pattern (${top.count} of ${top.of}).`);
  }
  const limitations = [];
  if (!p.surveyedCrashGeometry) {
    limitations.push(`Location confidence is limited: records are positioned using ${String(p.locationSourceLabel ?? 'derived locations').toLowerCase()} `
      + 'rather than surveyed coordinates, so this is a record-concentration comparison and not a validated crash-rate estimate.');
  }
  return Object.freeze({
    available: true,
    summary: [...parts, ...limitations].join(' '),
    patterns: locationHistory.crashTypes ?? [],
    limitations: Object.freeze(limitations),
  });
}

/**
 * Something ACS might look into — one or two sentences, and only where evidence supports it.
 *
 * Deliberately separate from risk and from mitigation. Risk is this incident's safety exposure;
 * mitigation is what an operator could do in the next hour; an opportunity is a recurring condition
 * worth a conversation later. Merging them would turn a standing observation into an alarm.
 *
 * Returns null when nothing in the data warrants one, which is the normal case.
 */
export function buildOpportunity({ locationHistory, upstream, resources, risk } = {}) {
  const grounds = [];
  const evidence = [];

  const concentrated = locationHistory?.available
    && ['ELEVATED', 'HIGH', 'VERY_HIGH'].includes(locationHistory.concentration?.level);
  if (concentrated) {
    grounds.push('recurring incident concentration');
    evidence.push(`${locationHistory.totals.crashes} records within ${locationHistory.analysisWindow.distanceMeters} m `
      + `in ${locationHistory.analysisWindow.lookbackMonths} months (${locationHistory.concentration.ratio}× the corridor comparison)`);
  }

  // A recurring circumstance that points at the corridor rather than at any one driver.
  const circumstance = (locationHistory?.contributingFactors ?? [])
    .find(entry => entry.share >= 0.2 && /work zone|construction|secondary/i.test(entry.value));
  if (circumstance) {
    grounds.push(`a recurring "${circumstance.value.toLowerCase()}" circumstance`);
    evidence.push(`${circumstance.value} recorded on ${circumstance.count} of ${circumstance.of} nearby records`);
  }

  const noUpstreamView = upstream?.status !== UPSTREAM_STATUS.RESOLVED || (!resources?.camera && !resources?.sign);
  if (noUpstreamView) {
    grounds.push('limited upstream observability in the connected data');
    evidence.push(upstream?.status !== UPSTREAM_STATUS.RESOLVED
      ? `Upstream direction could not be determined (${sentence(upstream?.reason ?? 'carriageway unresolved').toLowerCase()})`
      : 'No upstream camera or sign resolved within range');
  }

  const persistentGaps = (risk?.unavailableFactors ?? []).length + (risk?.unknownFactors ?? []).length;
  if (!grounds.length) return null;

  return Object.freeze({
    headline: 'Opportunity for investigation',
    // "Review", never "install": nothing here evidences what a capital change would achieve.
    summary: `This corridor area shows ${joinList(grounds)}. ACS may want to review monitoring coverage and `
      + 'incident-response procedures for this area.',
    evidence: Object.freeze(evidence),
    limitations: Object.freeze([
      'Based on recorded incident data, which is a record of what was filed rather than a survey of what occurred.',
      ...(locationHistory?.provenance?.surveyedCrashGeometry ? [] :
        ['Historical locations are derived from damaged-asset coordinates, so the concentration is approximate.']),
      ...(persistentGaps ? [`${persistentGaps} operational fields were unavailable for this assessment.`] : []),
    ]),
  });
}
