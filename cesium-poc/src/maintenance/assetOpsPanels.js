/**
 * The card shown over the map while one ACS case is focused.
 *
 * All that is left of what was once the Operations Overview's analysis panel: that panel was
 * removed, and this card is the one piece of it that belongs to the case flow rather than to the
 * map. It is kept here so the workbench stays a view over the model rather than a markup file.
 */
import { escape } from '../safetyIntelligence/safetyPanels.js';
import { plainName } from './caseWorkbenchModel.js';

/* ── Case Map Focus Mode ─────────────────────────────────────────────────────────────────────── */

/**
 * The one card on screen while a case is focused on the map.
 *
 * Its job is to be unmistakable about two different records. The case is synthetic and is what the
 * operator asked to see; the marker underneath the camera is a real incident in the register, with
 * its own type and date, whose coordinates the case borrows. Showing the incident's own card here
 * — which is what happened before — reads as though the incident were the case.
 */
export function caseFocusCard({ record, location, corridorMile, error }) {
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
    ${error ? `<p class="cw-focus-error">${escape(error)}</p>` : ''}
    <button type="button" class="cw-action" data-action="return-to-case">Return to ${escape(record.id)}</button>`;
}
