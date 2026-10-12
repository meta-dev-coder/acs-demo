/**
 * prioritize_sites: which asset sites to fix first, under switchable criteria. Dan's example: a
 * maintenance team orders three camera sites first-in-first-out or by distance; an executive turns
 * on Tolling & revenue and may see a different site go first. The joins (asset -> open work orders
 * -> inspections -> toll revenue) happen here, in code, never in the model.
 *
 * Every number comes from the twin's records or the stated config; a criterion with no data is NA
 * for that site and contributes nothing, and the answer says so.
 */
import CONFIG from '../../config/askTwin/prioritization.json' with { type: 'json' };
import { haversineMeters } from '../geo.mjs';
import { originOf } from './twinStore.mjs';

export const PRESETS = Object.freeze(CONFIG.presets);
const CLOSED = new Set(CONFIG.openStatuses.exclude);
const DAY = 86_400_000;
const PRIORITY = { high: 3, medium: 2, low: 1, critical: 4, emergency: 4 };
const round = (n, d = 1) => (Number.isFinite(n) ? Number(n.toFixed(d)) : null);
const pick = (r, ...names) => { for (const n of names) if (r?.[n] !== undefined && r[n] !== null && r[n] !== '') return r[n]; return null; };

export const PRIORITIZE_DEFINITION = Object.freeze({
  name: 'prioritize_sites',
  description: 'Which asset sites to fix first (e.g. cameras with open work orders), ranked by switchable criteria: first-in-first-out age, distance from the depot, inspection risk, work-order priority, and toll revenue at risk (only when Tolling & revenue is in scope). Presets: maintenance (FIFO/distance), nearest, executive (revenue-weighted). Returns the ranking, each criterion\'s contribution, and how each site moves versus the other preset. Computed by the twin; never rank sites yourself.',
  input_schema: {
    type: 'object',
    properties: {
      asset_type: { type: 'string', description: 'Asset Category, e.g. Camera, DMS, Detector (default Camera)' },
      preset: { type: 'string', enum: Object.keys(CONFIG.presets) },
      from: { type: 'object', properties: { lon: { type: 'number' }, lat: { type: 'number' } }, description: 'Measure distance from here instead of the depot' },
    },
  },
});

/** Normalise one criterion across candidates to 0..1 (1 = most urgent); NA stays null. */
function normalise(values, higherIsUrgent) {
  const known = values.filter(v => v !== null);
  const min = Math.min(...known), max = Math.max(...known);
  return values.map(v => (v === null ? null : max === min ? (known.length ? 1 : null) : (higherIsUrgent ? (v - min) / (max - min) : (max - v) / (max - min))));
}

/** Rank candidates under a weight set. */
export function rankSites(sites, weights) {
  const names = Object.keys(weights).filter(k => weights[k] > 0);
  const norm = {};
  for (const c of names) norm[c] = normalise(sites.map(s => s.values[c] ?? null), c !== 'distance');
  const scored = sites.map((s, i) => {
    const contributions = {};
    let score = 0;
    for (const c of names) {
      const v = norm[c][i];
      contributions[c] = v === null ? null : round(weights[c] * v, 3);
      score += contributions[c] ?? 0;
    }
    return { ...s, score: round(score, 3), contributions };
  });
  // Ties go to the older work order, so the order is stable and defensible.
  scored.sort((a, b) => b.score - a.score || (b.values.fifo ?? 0) - (a.values.fifo ?? 0));
  return scored.map((s, i) => ({ ...s, rank: i + 1 }));
}

/**
 * @param {{store: object, readLayer?: Function, now?: () => number}} deps
 */
export function createPrioritizer({ store, now = Date.now }) {
  function revenueBySite(names) {
    const links = new Map(CONFIG.siteRevenue.links.map(l => [l.asset.toLowerCase(), l]));
    const tolls = store.rows('I595 Toll Transactions');
    if (tolls.gap) return { gap: tolls.gap.detail ?? 'Toll transactions are not loaded.' };
    const meta = store.classes().find(c => c.className === tolls.className);
    const perGantry = new Map();
    for (const r of tolls.records) {
      const id = r.gantry_id;
      const g = perGantry.get(id) ?? { days: 0, image: 0, transactions: 0 };
      g.days += 1;
      g.image += Number(r.image_dependent_revenue_usd) || 0;
      g.transactions += Number(r.transactions) || 0;
      perGantry.set(id, g);
    }
    const out = new Map();
    for (const name of names) {
      const link = links.get(String(name).toLowerCase());
      const g = link ? perGantry.get(link.gantry_id) : null;
      if (!link || !g?.days) { out.set(name, null); continue; }
      const daily = g.image / g.days;
      out.set(name, { usdPerDay: round(daily * link.share * CONFIG.siteRevenue.unrecoverableFraction, 0), gantry: link.gantry_id,
        gantryTransactionsPerDay: Math.round(g.transactions / g.days), share: link.share, why: link.why });
    }
    return { bySite: out, origin: originOf(meta?.source), asOf: tolls.asOf };
  }

  return function prioritizeSites({ asset_type = 'Camera', preset, from } = {}, { scope = null } = {}) {
    const financeOn = !scope || scope.has('finance');
    const chosen = PRESETS[preset] ? preset : financeOn ? 'executive' : 'maintenance';
    const compareTo = chosen === 'executive' ? 'maintenance' : financeOn ? 'executive' : null;

    const assets = store.rows('Florida I595 Assets');
    if (assets.gap) return { output: assets, source: null };
    const wos = store.rows('Florida I595 Work Orders');
    if (wos.gap) return { output: wos, source: null };
    const inspections = store.rows('Florida I595 ITS Inspections');

    const type = String(asset_type).toLowerCase();
    const ofType = assets.records.filter(a => String(pick(a, 'Asset Category', 'asset category', 'category') ?? '').toLowerCase() === type);
    const byId = new Map(ofType.map(a => [String(pick(a, 'Asset ID', 'asset id', 'keyInSource', 'key')), a]));
    const open = new Map();
    for (const w of wos.records) {
      const id = String(pick(w, 'Asset ID', 'asset id') ?? '');
      const status = String(pick(w, 'Work Order Status', 'work order status', 'status') ?? '').toLowerCase();
      if (!byId.has(id) || CLOSED.has(status)) continue;
      if (!open.has(id)) open.set(id, []);
      open.get(id).push({ id: pick(w, 'Work Order ID', 'keyInSource') ?? w.key, status: pick(w, 'Work Order Status', 'status'), opened: String(w._at ?? pick(w, 'Work Order Open Date') ?? '').slice(0, 10) || null,
        priority: pick(w, 'Priority', 'priority'), type: pick(w, 'Work Type', 'work type') });
    }
    if (!open.size) {
      return { output: { asset_type, sites: [], gaps: [`No ${asset_type} asset has an open work order in the register.`] }, source: 'Twin insight · site prioritisation', summary: 'no open work orders' };
    }

    const depot = from && Number.isFinite(from.lon) && Number.isFinite(from.lat) ? { id: 'selection', name: 'the given point', lon: from.lon, lat: from.lat, assumed: false } : CONFIG.depots[0];
    const recentRisk = new Map();
    if (!inspections.gap) {
      for (const r of inspections.records) {
        const key = String(pick(r, 'asset_id') ?? '').toLowerCase();
        const list = recentRisk.get(key) ?? [];
        if (list.length < 3) list.push(Number(pick(r, 'risk_rating_1_5')) || null); // rows() is newest first
        recentRisk.set(key, list);
      }
    }
    const names = [...open.keys()].map(id => String(pick(byId.get(id), 'Asset Description', 'asset description', 'name') ?? id));
    const revenue = financeOn ? revenueBySite(names) : null;

    const sites = [...open.entries()].map(([id, orders]) => {
      const asset = byId.get(id);
      const name = String(pick(asset, 'Asset Description', 'asset description', 'name') ?? id);
      const lon = asset._lon, lat = asset._lat;
      const oldest = orders.map(o => o.opened).filter(Boolean).sort()[0] ?? null;
      const risks = (recentRisk.get(name.toLowerCase()) ?? []).filter(Boolean);
      const rev = revenue?.bySite?.get(name) ?? null;
      const notEvaluated = [];
      if (!Number.isFinite(lon)) notEvaluated.push('distance (no position)');
      if (!risks.length) notEvaluated.push('inspection (no ITS inspection on record)');
      if (financeOn && !rev) notEvaluated.push(revenue?.gap ? `revenue (${revenue.gap})` : 'revenue (no camera-to-gantry link)');
      return {
        asset_id: id, site: name, lon: round(lon, 5), lat: round(lat, 5), open_work_orders: orders,
        values: {
          fifo: oldest ? Math.round((now() - Date.parse(oldest)) / DAY) : null,
          distance: Number.isFinite(lon) ? round(haversineMeters(depot.lon, depot.lat, lon, lat) / 1000, 2) : null,
          inspection: risks.length ? Math.max(...risks) : null,
          priority: Math.max(0, ...orders.map(o => PRIORITY[String(o.priority ?? '').toLowerCase()] ?? 0)) || null,
          revenue: rev?.usdPerDay ?? null,
        },
        revenue: rev, notEvaluated,
      };
    });

    const weights = { ...PRESETS[chosen].weights };
    if (!financeOn) delete weights.revenue;
    const ranked = rankSites(sites, weights);
    const other = compareTo ? rankSites(sites, Object.fromEntries(Object.entries(PRESETS[compareTo].weights).filter(([k]) => financeOn || k !== 'revenue'))) : null;
    const otherRank = new Map((other ?? []).map(s => [s.asset_id, s.rank]));

    const gaps = [];
    if (!financeOn) gaps.push('Tolling & revenue is toggled off, so revenue impact is not part of this ranking.');
    if (depot.assumed) gaps.push(`Distance is measured from an assumed depot (${depot.name}); the twin has no crew or depot locations.`);
    gaps.push('No SLA response targets are in the twin, so no site is pinned ahead by contract.');
    if (revenue?.origin === 'synthetic') gaps.push('Revenue at risk uses SYNTHETIC toll transactions and demo camera-to-gantry links, not FDOT data.');
    const fmt = s => ({ rank: s.rank, site: s.site, asset_id: s.asset_id, score: s.score, lon: s.lon, lat: s.lat,
      oldest_open_since: s.open_work_orders.map(o => o.opened).filter(Boolean).sort()[0] ?? null, open_work_orders: s.open_work_orders,
      age_days: s.values.fifo, distance_km: s.values.distance, inspection_risk: s.values.inspection, priority: s.values.priority,
      revenue_at_risk_usd_per_day: s.values.revenue, ...(s.revenue ? { revenue_basis: `${s.revenue.gantry}: ${s.revenue.gantryTransactionsPerDay} transactions/day, ${Math.round(s.revenue.share * 100)}% of its image-dependent revenue relies on this camera (${s.revenue.why})` } : {}),
      contributions: s.contributions, ...(compareTo ? { rank_under_other_preset: otherRank.get(s.asset_id), moved: otherRank.get(s.asset_id) - s.rank } : {}),
      ...(s.notEvaluated.length ? { notEvaluated: s.notEvaluated } : {}) });
    const top = ranked[0];
    return {
      output: {
        asset_type, preset: chosen, preset_label: PRESETS[chosen].label, weights, depot: { name: depot.name, assumed: Boolean(depot.assumed) },
        ...(compareTo ? { compared_with: compareTo, compared_label: PRESETS[compareTo].label } : {}),
        sites: ranked.map(fmt), gaps,
        sourcesUsed: financeOn && revenue && !revenue.gap ? ['finance'] : [],
      },
      source: `Twin insight · site prioritisation (${PRESETS[chosen].label})${revenue?.origin === 'synthetic' ? ' · synthetic tolls' : ''}`,
      summary: `${top.site} first under ${PRESETS[chosen].label}${compareTo && otherRank.get(top.asset_id) !== 1 ? ` (#${otherRank.get(top.asset_id)} under ${PRESETS[compareTo].label})` : ''}`,
    };
  };
}
