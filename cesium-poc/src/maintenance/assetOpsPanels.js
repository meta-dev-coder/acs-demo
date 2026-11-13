/**
 * The card shown over the map while one ACS case is focused.
 *
 * All that is left of what was once the Operations Overview's analysis panel: that panel was
 * removed, and this card is the one piece of it that belongs to the case flow rather than to the
 * map. It is kept here so the workbench stays a view over the model rather than a markup file.
 */
import { escape } from '../safetyIntelligence/safetyPanels.js';
import { plainName } from './caseWorkbenchModel.js';
import { RADII_M, distanceLabel, summarise } from '../acs/nearbyCrashes.js';

/* ── Case Map Focus Mode ─────────────────────────────────────────────────────────────────────── */

/**
 * The one card on screen while a case is focused on the map.
 *
 * Its job is to be unmistakable about two different records. The case is synthetic and is what the
 * operator asked to see; the marker underneath the camera is a real incident in the register, with
 * its own type and date, whose coordinates the case borrows. Showing the incident's own card here
 * — which is what happened before — reads as though the incident were the case.
 */
export function caseFocusCard({ record, location, corridorMile, error, history = null }) {
  const demoCase = record.demoCase;
  const evaluation = record.evaluation;
  const sameKind = location.sourceIncidentType
    && location.sourceIncidentType.toLowerCase() === demoCase.incident.incidentType.toLowerCase();
  const where = [
    location.roadway, location.segmentId, location.direction,
    Number.isFinite(corridorMile) ? `corridor mile ${corridorMile.toFixed(2)} (derived)` : null,
  ].filter(Boolean).join(' · ');

  return `<header class="cw-focus-head">
      <span class="cw-focus-kicker">ACS case on the map</span>
      <h2>${escape(record.id)}</h2>
    </header>
    <p class="cw-focus-asset">${escape(demoCase.asset.assetType)} · ${escape(plainName(demoCase.asset.assetName))}</p>
    <p class="cw-focus-status" data-tone="${escape(evaluation.presentation.tone)}">${escape(evaluation.presentation.label)}</p>
    <div class="cw-focus-block">
      <em>Action required</em>
      <p>${escape(evaluation.nextAction.text)}</p>
    </div>
    <div class="cw-focus-block">
      <em>Where this is</em>
      <p>${escape(where || 'Location not recorded')}</p>
    </div>
    <div class="cw-focus-block cw-focus-source">
      <em>Marker on the map</em>
      <p><strong>${escape(location.sourceIncidentId ?? 'No source incident')}</strong>${
        location.sourceIncidentType ? ` · ${escape(location.sourceIncidentType)}` : ''}${
        location.sourceIncidentDate ? ` · ${escape(String(location.sourceIncidentDate))}` : ''}</p>
      <p class="cw-focus-warn">${sameKind
        ? `This is a real incident in the corridor register. ${escape(record.id)} is synthetic and reuses `
          + 'only its location; the damage, repair and claim in the case did not happen here.'
        : `This is a real <strong>${escape(location.sourceIncidentType ?? 'incident')}</strong> in the corridor `
          + `register — a different event from this case, which concerns `
          + `<strong>${escape(demoCase.asset.assetType)}</strong>. ${escape(record.id)} is synthetic and reuses `
          + 'only this incident’s coordinates.'}</p>
    </div>
    ${historyMarkup(history)}
    ${error ? `<p class="cw-focus-error">${escape(error)}</p>` : ''}
    <button type="button" class="cw-action" data-action="return-to-case">Return to ${escape(record.id)}</button>`;
}

/* ── accident history at the same spot ───────────────────────────────────────────────────────── */

/**
 * What else the corridor register records near this point.
 *
 * Collapsed to a single button until it is asked for: the case is what the operator opened, and a
 * list of sixty other incidents unfurling over the map beside it answers a question nobody asked
 * yet. Once open it is counts first, then every incident with its own distance, date and facts.
 *
 * The caveat is shown with the counts, not tucked under them. A count of crashes in a circle is
 * EXPOSURE — a busier place has more — and without a published traffic volume for this location
 * it cannot be turned into a rate. Saying so next to the number is the difference between a fact
 * and an implied risk score.
 */
function historyMarkup(history) {
  if (!history) return '';
  const { open, loading, found, radiusM, error } = history;
  const count = found?.available ? found.total : null;
  const label = !found ? 'Accident history at this spot'
    : !found.available ? 'Accident history unavailable'
      : count === 0 ? `No other recorded incident within ${radiusM} m`
        : `${count} other recorded incident${count === 1 ? '' : 's'} within ${radiusM} m`;

  const head = `<button type="button" class="cw-action cw-focus-history-toggle"
      data-action="toggle-crash-history" aria-expanded="${open ? 'true' : 'false'}">
      ${loading ? 'Reading the incident register…' : escape(label)}</button>`;
  if (!open) return `<div class="cw-focus-block cw-focus-history">${head}</div>`;

  if (error) {
    return `<div class="cw-focus-block cw-focus-history">${head}
      <p class="cw-focus-error">${escape(error)}</p></div>`;
  }
  if (!found?.available) {
    return `<div class="cw-focus-block cw-focus-history">${head}
      <p class="cw-focus-warn">${escape(found?.reason ?? 'No location to search around.')}</p></div>`;
  }

  const stats = summarise(found);
  const radii = `<div class="cw-focus-radii" role="group" aria-label="Search radius">
    ${RADII_M.map(metres => `<button type="button" data-action="crash-radius" data-radius="${metres}"
      aria-pressed="${metres === radiusM}">${metres < 1000 ? `${metres} m` : `${metres / 1000} km`}</button>`).join('')}
  </div>`;

  if (!stats.total) {
    return `<div class="cw-focus-block cw-focus-history">${head}${radii}
      <p class="cw-focus-warn">The corridor incident register records nothing else within
        ${escape(radiusM)} m of this point. That is the register's coverage, not a statement that
        nothing has ever happened here.</p></div>`;
  }

  return `<div class="cw-focus-block cw-focus-history">${head}${radii}
    <dl class="cw-focus-stats">
      <div><dt>Recorded incidents</dt><dd>${escape(stats.total)}</dd></div>
      <div><dt>With injuries</dt><dd data-tone="${stats.withInjuries ? 'warn' : ''}">${escape(stats.withInjuries)}</dd></div>
      <div><dt>Fatalities</dt><dd data-tone="${stats.fatalities ? 'bad' : ''}">${escape(stats.fatalities)}</dd></div>
      <div><dt>Closed lanes</dt><dd>${escape(stats.withLaneClosure)}</dd></div>
    </dl>
    ${stats.earliestYear ? `<p class="cw-focus-span">${escape(stats.earliestYear)}–${escape(stats.latestYear)}
      · nearest ${escape(distanceLabel(stats.nearestM))}</p>` : ''}
    ${stats.byType.length > 1 ? `<ul class="cw-focus-chips">${stats.byType.slice(0, 6).map(entry =>
    `<li><span>${escape(entry.key)}</span><b>${escape(entry.count)}</b></li>`).join('')}</ul>` : ''}
    <ol class="cw-focus-crashes">${found.records.map(crash => `<li>
      <p class="cw-focus-crash-head"><strong>${escape(crash.type)}</strong>
        <span>${escape(distanceLabel(crash.distanceM))}</span></p>
      <p class="cw-focus-crash-meta">${escape(crash.id ?? 'No id')}${
  crash.date ? ` · ${escape(crash.date)}` : ''}${crash.segment ? ` · ${escape(crash.segment)}` : ''}</p>
      ${crash.injuries || crash.fatalities || crash.laneClosure ? `<p class="cw-focus-crash-flags">
        ${crash.fatalities ? `<span data-tone="bad">${escape(crash.fatalities)} fatality(ies)</span>` : ''}
        ${crash.injuries ? '<span data-tone="warn">Injuries reported</span>' : ''}
        ${crash.laneClosure ? '<span data-tone="warn">Lane closure</span>' : ''}</p>` : ''}
      ${crash.rootCause ? `<p class="cw-focus-crash-meta">Root cause: ${escape(crash.rootCause)}</p>` : ''}
      ${crash.description ? `<p class="cw-focus-crash-meta">${escape(crash.description)}</p>` : ''}
      <p class="cw-focus-crash-src">${escape(crash.source)}</p>
    </li>`).join('')}</ol>
    ${found.total > found.records.length
    ? `<p class="cw-focus-span">Showing ${escape(found.records.length)} of ${escape(found.total)}.</p>` : ''}
    <p class="cw-focus-warn">${escape(stats.caveat)}</p>
  </div>`;
}
