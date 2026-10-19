/**
 * Writes the SYNTHETIC per-gantry daily toll transactions the twin uses until real FDOT data is
 * imported (tools/import-toll-transactions.mjs). Deterministic: the same config always gives the same
 * file, so tests and demos are repeatable.
 *
 *   node tools/generate-toll-transactions.mjs        # writes public/dataconnect-data/toll_transactions_synthetic.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT_FILE = join(ROOT, 'public', 'dataconnect-data', 'toll_transactions_synthetic.json');

/** A small seeded PRNG (mulberry32), so the "noise" is the same on every run. */
function prng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * @param {object} config  config/askTwin/syntheticTolls.json
 * @param {object} gantries  the express gantries GeoJSON
 * @returns {object[]} one record per gantry per day
 */
export function generateTollTransactions(config, gantries) {
  const random = prng(config.seed);
  const end = Date.parse(`${config.endDate}T00:00:00Z`);
  const rows = [];
  for (const feature of gantries.features ?? []) {
    const id = feature.properties?.gantry_id;
    const base = config.gantries[id];
    if (!base) continue;
    const [lon, lat] = feature.geometry.coordinates;
    for (let d = config.days - 1; d >= 0; d--) {
      const day = new Date(end - d * 86_400_000);
      const weekend = [0, 6].includes(day.getUTCDay());
      const transactions = Math.round(base.dailyTransactions * (weekend ? config.weekendFactor : 1) * (0.92 + random() * 0.16));
      const image = Math.round(transactions * config.imageDependentShare * (0.85 + random() * 0.3));
      const avgToll = Number((base.avgTollUsd * (0.95 + random() * 0.1)).toFixed(2));
      const date = day.toISOString().slice(0, 10);
      rows.push({
        record_id: `${id}-${date}`, gantry_id: id, gantry_name: feature.properties.name, date, transactions,
        transponder_transactions: transactions - image, image_dependent_transactions: image, avg_toll_usd: avgToll,
        revenue_usd: Math.round(transactions * avgToll), image_dependent_revenue_usd: Math.round(image * avgToll),
        lon, lat, synthetic: true,
      });
    }
  }
  return rows;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(readFileSync(join(ROOT, 'config', 'askTwin', 'syntheticTolls.json'), 'utf8'));
  const gantries = JSON.parse(readFileSync(join(ROOT, 'public', 'data', 'i595_express_gantries.geojson'), 'utf8'));
  const rows = generateTollTransactions(config, gantries);
  writeFileSync(OUT_FILE, `${JSON.stringify(rows, null, 1)}\n`);
  console.log(`wrote ${rows.length} synthetic records to ${OUT_FILE}`);
}
