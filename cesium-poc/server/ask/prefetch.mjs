/**
 * Lookups to run before the model is asked: the insight a question obviously needs.
 *
 * A question about the selected incident needs the TMC risk model's assessment of it; a question
 * about rain and crashes needs the forecast scenario. Running those first means their result is on
 * screen within a moment and the model starts from it instead of spending a round deciding to ask.
 * Only plainly recognised intents are planned here; everything else is left to the model.
 *
 * Pure: an envelope in, a list of `{name, input, why}` out.
 */
import PLACES from '../../config/askTwin/places.json' with { type: 'json' };
const ABOUT_SELECTION = /\b(this|it|its|here|why|risk|risky|incident|crash|what should|mitigat|upstream|camera)\b/;
const WEATHER = /\b(rain|raining|weather|storm|showers?|forecast|wet)\b|next \d+ ?(h|hours?)/;
const SAFETY = /\b(crash|crashes|risk|patrol|where|segment|section|safety|danger|prepare|pre-?position)\b/;
const HOTSPOT = /\b(hotspots?|most crashes|worst (segment|section|stretch|spot)|dangerous|crash-prone|high-crash)\b/;
/** Words that make a weather question about what is coming, not about the past record. */
const AHEAD = /\b(forecast|coming|expected|later|tonight|tomorrow|today|this (afternoon|evening|morning)|pre-?position|prepare)\b|next \d+ ?(h|hours?)/;
/** "Which sites first?" questions: the twin ranks sites itself (prioritize_sites). */
const PRIORITIZE = /\b(prioriti[sz]e|priority order|which (one|site|camera|sign|detector)s? (first|next)|fix first|repair first|order of (work|repairs?)|replace(ment)?s? first|what (should|do) we (fix|repair) first)\b/;
const ASSET_TYPES = [[/\b(cameras?|cctv)\b/, 'Camera'], [/\b(dms|message signs?)\b/, 'DMS'], [/\bdetectors?\b/, 'Detector'], [/\bgenerators?\b/, 'Generator']];

/** Words that make a place question about the record (records_near over incidents). */
const HISTORY = /\b(history|historical|incidents?|crash(es)?|accidents?|how many|record(ed)?|past|happened)\b/;
const PLACE_PATTERNS = PLACES.places.map(p => ({ ...p, re: new RegExp(p.match) }));

const RANKING = /\b(riskiest|highest (secondary )?risk|rank|which incidents?|most urgent|needs? attention)\b/;

/** @param {{question: string, screen: object}} envelope */
export function planPrefetch(envelope) {
  const q = String(envelope?.question ?? '').toLowerCase();
  const selection = envelope?.screen?.selection;
  const temporal = envelope?.screen?.temporal;
  const plan = [];
  if (selection?.type === 'incident' && ABOUT_SELECTION.test(q)) {
    plan.push({ name: 'explain_incident', input: { incident_id: selection.id, ...(temporal ? { temporal } : {}) },
      why: `Assessing the selected incident ${selection.id} with the TMC risk model first.` });
  } else if (RANKING.test(q)) {
    plan.push({ name: 'rank_incidents', input: {}, why: 'Ranking active incidents with the TMC risk model first.' });
  }
  // "Hotspots in wet weather" asks about the record; "rain is coming, where do we prepare" asks ahead.
  if (WEATHER.test(q) && (AHEAD.test(q) || (SAFETY.test(q) && !HOTSPOT.test(q)))) {
    plan.push({ name: 'weather_risk_forecast', input: { hours: 6 }, why: 'Checking the rain forecast against wet-weather crash history first.' });
  } else if (HOTSPOT.test(q)) {
    plan.push({ name: 'crash_hotspots', input: { weather: /\b(wet|rain)/.test(q) ? 'wet' : 'any' }, why: 'Ranking crash hotspots from the register first.' });
  }
  if (PRIORITIZE.test(q)) {
    const type = ASSET_TYPES.find(([re]) => re.test(q))?.[1] ?? 'Camera';
    plan.push({ name: 'prioritize_sites', input: { asset_type: type }, why: `Ranking ${type.toLowerCase()} sites with open work orders first.` });
  }
  // "Incident history at the Turnpike interchange": the model used to fall back on the coarse Segment
  // field and give up. The incidents around that interchange's ramps answer it directly.
  const place = PLACE_PATTERNS.find(p => p.re.test(q));
  if (place && HISTORY.test(q) && !plan.some(p => p.name === 'crash_hotspots')) {
    plan.push({ name: 'records_near', input: { class_name: 'Florida I595 Incidents', place: { layer: PLACES.layer, text: place.text }, radius_m: PLACES.radiusM, group_by: 'incident_type' },
      why: `Counting recorded incidents within ${PLACES.radiusM} m of the ${place.name} ramps first.` });
  }
  return plan;
}
