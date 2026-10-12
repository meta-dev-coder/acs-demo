/**
 * Loads REAL toll transactions (e.g. an FDOT / Florida's Turnpike extract) into the twin store,
 * replacing the synthetic 'I595 Toll Transactions' class. Read-only towards DataConnect: it writes
 * only the local SQLite store. The class is marked origin 'imported' so answers stop calling the
 * figures synthetic, and the scheduled DataConnect refresh keeps it (it only re-pulls DataConnect
 * classes).
 *
 *   node tools/import-toll-transactions.mjs <file.csv|file.json> [--store <path>] [--dry-run]
 *
 * Input: one row per gantry per day or per hour. Hourly rows are summed to days.
 *   required  gantry_id, date (or hour/timestamp: ISO or MM/DD/YYYY), transactions
 *   optional  image_dependent_transactions (aliases: image_transactions, video_transactions,
 *             plate_transactions), transponder_transactions, revenue_usd, avg_toll_usd,
 *             image_dependent_revenue_usd
 * Missing figures stay empty (NA), never estimated; revenue at risk needs the image-dependent split.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TOLL_CLASS = 'I595 Toll Transactions';
const ALIASES = {
  gantry_id: ['gantry_id', 'gantry', 'plaza_id', 'toll_point', 'site_id'],
  date: ['date', 'day', 'hour', 'timestamp', 'datetime', 'transaction_date'],
  transactions: ['transactions', 'total_transactions', 'count', 'volume'],
  image: ['image_dependent_transactions', 'image_transactions', 'video_transactions', 'plate_transactions', 'toll_by_plate_transactions'],
  transponder: ['transponder_transactions', 'sunpass_transactions', 'etc_transactions'],
  revenue: ['revenue_usd', 'revenue', 'toll_revenue_usd'],
  avgToll: ['avg_toll_usd', 'average_toll_usd', 'avg_toll'],
  imageRevenue: ['image_dependent_revenue_usd', 'image_revenue_usd'],
};

/** Minimal CSV parsing (quoted fields, commas, CRLF), enough for an agency extract. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter(r => r.some(v => v.trim()));
  const keys = (header ?? []).map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return body.map(r => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

const num = v => (v === undefined || v === null || String(v).trim() === '' ? null : Number(String(v).replace(/[$,]/g, '')));
const first = (row, names) => { for (const n of names) if (row[n] !== undefined && String(row[n]).trim() !== '') return row[n]; return undefined; };
const dayOf = value => {
  const text = String(value ?? '').trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
};

/**
 * Normalise raw rows into daily per-gantry records.
 * @param {object[]} raw
 * @param {{gantries?: Map<string, {lon, lat, name}>}} [options]
 * @returns {{rows: object[], report: object}}
 */
export function normalizeTollRows(raw, { gantries = new Map() } = {}) {
  const errors = [];
  const days = new Map();
  raw.forEach((input, index) => {
    const row = Object.fromEntries(Object.entries(input).map(([k, v]) => [String(k).trim().toLowerCase().replace(/\s+/g, '_'), v]));
    const gantry = String(first(row, ALIASES.gantry_id) ?? '').trim();
    const date = dayOf(first(row, ALIASES.date));
    const tx = num(first(row, ALIASES.transactions));
    if (!gantry || !date || tx === null || !Number.isFinite(tx) || tx < 0) {
      if (errors.length < 20) errors.push(`row ${index + 2}: needs gantry_id, a date and a non-negative transactions count`);
      return;
    }
    const key = `${gantry}|${date}`;
    const d = days.get(key) ?? { gantry, date, transactions: 0, image: null, transponder: null, revenue: null, imageRevenue: null, tollWeighted: null };
    d.transactions += tx;
    const add = (field, value) => { if (value !== null && Number.isFinite(value)) d[field] = (d[field] ?? 0) + value; };
    add('image', num(first(row, ALIASES.image)));
    add('transponder', num(first(row, ALIASES.transponder)));
    add('revenue', num(first(row, ALIASES.revenue)));
    add('imageRevenue', num(first(row, ALIASES.imageRevenue)));
    const avg = num(first(row, ALIASES.avgToll));
    if (avg !== null && Number.isFinite(avg)) d.tollWeighted = (d.tollWeighted ?? 0) + avg * tx;
    days.set(key, d);
  });
  const unknown = new Set();
  const rows = [...days.values()].map(d => {
    const g = gantries.get(d.gantry);
    if (gantries.size && !g) unknown.add(d.gantry);
    const avgToll = d.revenue !== null && d.transactions ? d.revenue / d.transactions : d.tollWeighted !== null && d.transactions ? d.tollWeighted / d.transactions : null;
    const revenue = d.revenue ?? (avgToll !== null ? avgToll * d.transactions : null);
    // The image-dependent revenue is only derived from an explicit image count and a known toll.
    const imageRevenue = d.imageRevenue ?? (d.image !== null && avgToll !== null ? d.image * avgToll : null);
    return {
      record_id: `${d.gantry}-${d.date}`, gantry_id: d.gantry, ...(g?.name ? { gantry_name: g.name } : {}), date: d.date,
      transactions: d.transactions, transponder_transactions: d.transponder ?? (d.image !== null ? d.transactions - d.image : null),
      image_dependent_transactions: d.image, avg_toll_usd: avgToll === null ? null : Number(avgToll.toFixed(2)),
      revenue_usd: revenue === null ? null : Math.round(revenue), image_dependent_revenue_usd: imageRevenue === null ? null : Math.round(imageRevenue),
      ...(g ? { lon: g.lon, lat: g.lat } : {}), synthetic: false,
    };
  }).sort((a, b) => a.gantry_id.localeCompare(b.gantry_id) || a.date.localeCompare(b.date));
  const dates = rows.map(r => r.date).sort();
  return { rows, report: { inputRows: raw.length, days: rows.length, gantries: [...new Set(rows.map(r => r.gantry_id))].length,
    from: dates[0] ?? null, to: dates.at(-1) ?? null, unknownGantries: [...unknown], withoutImageSplit: rows.filter(r => r.image_dependent_revenue_usd === null).length, errors } };
}

/** The gantry layer as id -> {lon, lat, name}. */
export function gantryIndex(geojson) {
  return new Map((geojson?.features ?? []).map(f => [f.properties?.gantry_id, { lon: f.geometry?.coordinates?.[0], lat: f.geometry?.coordinates?.[1], name: f.properties?.name }]));
}

/**
 * Replace the toll class in the store, keeping every other class as it is.
 * @returns {{outPath: string, rows: number}}
 */
export async function importIntoStore({ storePath, rows, label, snapshotDir }) {
  const { buildStoreFromSnapshot, openTwinStore, writeTwinStore, SNAPSHOT_CLASSES } = await import('../server/ask/twinStore.mjs');
  if (!existsSync(storePath)) buildStoreFromSnapshot({ snapshotDir, outPath: storePath });
  const store = openTwinStore(storePath);
  const others = store.classes().map(c => c.className).filter(name => name !== TOLL_CLASS);
  store.close();
  const spec = { ...SNAPSHOT_CLASSES.find(c => c.className === TOLL_CLASS), synthetic: false };
  writeTwinStore({ outPath: storePath, classes: [{ spec, rows, source: `import:${label}` }], keep: { path: storePath, classNames: others } });
  return { outPath: storePath, rows: rows.length };
}

async function main() {
  const argv = process.argv.slice(2);
  const file = argv.find(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--store');
  if (!file) throw new Error('usage: node tools/import-toll-transactions.mjs <file.csv|file.json> [--store <path>] [--dry-run]');
  const storeArg = argv.includes('--store') ? resolve(argv[argv.indexOf('--store') + 1]) : null;
  const text = readFileSync(resolve(file), 'utf8');
  const raw = /\.json$/i.test(file) ? JSON.parse(text) : parseCsv(text);
  if (!Array.isArray(raw)) throw new Error('JSON input must be an array of rows');
  const gantries = gantryIndex(JSON.parse(readFileSync(join(ROOT, 'public', 'data', 'i595_express_gantries.geojson'), 'utf8')));
  const { rows, report } = normalizeTollRows(raw, { gantries });
  console.log(JSON.stringify(report, null, 2));
  if (!rows.length) throw new Error('no usable rows; nothing imported');
  if (argv.includes('--dry-run')) return;
  const storePath = storeArg ?? process.env.ASK_TWIN_STORE ?? join(ROOT, '.twin-store', 'twin.sqlite');
  const done = await importIntoStore({ storePath, rows, label: basename(file), snapshotDir: process.env.LIVE_DC_DATA_DIR ? join(process.env.LIVE_DC_DATA_DIR, 'dataconnect-data') : join(ROOT, 'public', 'dataconnect-data') });
  console.log(`imported ${done.rows} daily gantry records into ${done.outPath} as '${TOLL_CLASS}' (origin: imported). Restart the ask service (or wait for its next refresh) to use them.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`import-toll-transactions: ${error.message}`); process.exitCode = 1; });
}
