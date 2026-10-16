/**
 * Illustrative equipment data for the gantry — demo data, and labelled as such everywhere.
 *
 * Nothing on this gantry is connected to a feed. To let the twin show what an equipped gantry
 * would look like, and to give the coming failure/revenue scenarios something to vary, a synthetic
 * record was produced for each modelled part: a baseline operational status, a health score, a
 * plausible manufacturer and model, a serial number and two dates.
 *
 * Three rules keep that from turning into a lie:
 *
 *   1. It is a STATIC FILE, not a generator. The same asset shows the same values on every load,
 *      so nothing silently changes under an operator between two looks at the same antenna.
 *   2. It never touches identity or geometry. Asset ids, node names and bounds come from the GLB
 *      manifest; this file is matched to it BY ASSET ID and may only add the fields listed in
 *      `SYNTHETIC_FIELDS`. A record it does not cover simply has no synthetic data.
 *   3. `operationalStatus` is the synthetic BASELINE. `simulationState` is what a what-if scenario
 *      will write, and the two are kept apart — a scenario marking an antenna FAILED must never be
 *      read back as the condition the asset is actually in.
 */
import manifest from '../../config/gantryEquipment/i595-gantry-1-toll-plaza.json' with { type: 'json' };
import synthetic from '../../config/gantryEquipment/i595-gantry-1-toll-plaza.synthetic.json' with { type: 'json' };

/** The only fields this overlay may contribute. Anything else in the file is ignored. */
export const SYNTHETIC_FIELDS = Object.freeze([
  'operationalStatus', 'health', 'manufacturer', 'modelNumber', 'serialNumber',
  'lastInspection', 'lastMaintenance', 'dataOrigin', 'baselineReliability', 'simulationState',
]);

/** The baseline conditions the file may state, with how each one reads on screen. */
export const OPERATIONAL_STATUSES = Object.freeze({
  OPERATIONAL: Object.freeze({ id: 'OPERATIONAL', label: 'Operational', tone: 'ok' }),
  DEGRADED: Object.freeze({ id: 'DEGRADED', label: 'Degraded', tone: 'warn' }),
  FAILED: Object.freeze({ id: 'FAILED', label: 'Failed', tone: 'bad' }),
  UNDER_MAINTENANCE: Object.freeze({ id: 'UNDER_MAINTENANCE', label: 'Under maintenance', tone: 'info' }),
});

/** Said in full wherever the data is shown; the short form is the chip beside it. */
export const SYNTHETIC_LABEL = 'Synthetic demo data';
export const SYNTHETIC_EXPLANATION =
  'Illustrative equipment data generated for digital twin demonstration and scenario testing. '
  + 'Not connected to actual FDOT equipment.';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A calendar date as an operator reads it: "15 Sep 2026".
 *
 * Parsed as plain calendar parts rather than through `Date`, which would shift the day across a
 * timezone and report a maintenance visit as having happened the evening before.
 */
export function formatDate(value) {
  const found = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!found) return null;
  const [, year, month, day] = found;
  const name = MONTHS[Number(month) - 1];
  return name ? `${Number(day)} ${name} ${year}` : null;
}

/** "92% — GOOD", or null when the record carries no usable score. */
export function healthLabel(health) {
  const score = Number(health?.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) return null;
  const condition = String(health?.condition ?? '').trim();
  return condition ? `${score}% — ${condition}` : `${score}%`;
}

/** What one status means on screen; an unrecognised one is shown as itself, in no colour. */
export const statusPresentation = status => OPERATIONAL_STATUSES[String(status ?? '').toUpperCase()]
  ?? (String(status ?? '').trim() ? { id: String(status), label: String(status), tone: 'muted' } : null);

const pick = record => Object.fromEntries(SYNTHETIC_FIELDS
  .filter(field => record?.[field] !== undefined)
  .map(field => [field, record[field]]));

/** assetId -> the synthetic fields for it. Built once; the file is static. */
const BY_ASSET_ID = new Map((synthetic?.assets ?? []).map(record => [record.assetId, Object.freeze(pick(record))]));

/** The synthetic fields for one asset, or an empty object when the file does not cover it. */
export const syntheticFor = assetId => BY_ASSET_ID.get(assetId) ?? null;

/** What the file says about itself: where it came from and that it is not telemetry. */
export const syntheticProvenance = Object.freeze({
  label: SYNTHETIC_LABEL,
  // What it is, then what the file itself says about it. Both, because the first is the sentence an
  // operator needs and the second is the data's own account of itself.
  explanation: [SYNTHETIC_EXPLANATION, synthetic?.syntheticData?.note].filter(Boolean).join(' '),
  description: synthetic?.syntheticData?.description ?? null,
  generatedOn: synthetic?.syntheticData?.generatedOn ?? null,
});

/**
 * Whether the overlay still describes the model the manifest was generated from.
 *
 * Checked rather than assumed: the two files are separate, the manifest is regenerated whenever the
 * GLB is re-exported, and a synthetic record left pointing at an asset id that no longer exists
 * would otherwise show an operator the health of something that is not there.
 *
 * @returns {{matched: number, missing: string[], unknown: string[], renamed: string[], sameModel: boolean}}
 */
export function reconcile(manifestAssets = manifest.assets, overlay = synthetic) {
  const byId = new Map(manifestAssets.map(asset => [asset.assetId, asset]));
  const records = overlay?.assets ?? [];
  const seen = new Set();
  const unknown = [];
  const renamed = [];
  for (const record of records) {
    const asset = byId.get(record.assetId);
    if (!asset) { unknown.push(record.assetId); continue; }
    seen.add(record.assetId);
    if (record.nodeName && record.nodeName !== asset.nodeName) renamed.push(record.assetId);
  }
  return {
    matched: seen.size,
    missing: manifestAssets.filter(asset => !seen.has(asset.assetId)).map(asset => asset.assetId),
    unknown,
    renamed,
    sameModel: overlay?.source?.sha256 === manifest.source.sha256,
  };
}
