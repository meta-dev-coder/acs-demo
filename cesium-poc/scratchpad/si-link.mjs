import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const acs = JSON.parse(readFileSync('scratchpad/acs-rows.json', 'utf8'));
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => document.querySelector('.si-loader')?.hidden === true,
  null, { timeout: 180000 });
console.log(JSON.stringify(await page.evaluate(acs => {
  const hdr = acs[0], data = acs.slice(1).filter(r => Object.keys(r).length);
  const recs = window.__maintenance.recordsOf('incidents').filter(r => !r.live);
  const live = window.__maintenance.recordsOf('incidents').filter(r => r.live);
  const at = r => r.raw?.attributes ?? r.raw ?? r;
  const assets = window.__maintenance.assetIndex();

  // -- register date range, in its own DD/MM/YYYY format
  const iso = s => { const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(s ?? ''));
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
  const regDates = recs.map(r => iso(at(r).incident_date)).filter(Boolean).sort();

  // -- ACS dates (col L is the form date; col B the submission timestamp)
  const acsIso = s => { s = String(s ?? '').trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
    return m ? `${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}` : null; };
  const acsDates = data.map(r => acsIso(r.L) ?? acsIso(r.B)).filter(Boolean).sort();

  // -- join 1: same calendar day
  const regByDay = new Map();
  for (const r of recs) { const d = iso(at(r).incident_date); if (!d) continue;
    regByDay.set(d, [...(regByDay.get(d) ?? []), at(r).code]); }
  const dayHits = data.map(r => ({ task: r.A, day: acsIso(r.L) ?? acsIso(r.B),
    matches: regByDay.get(acsIso(r.L) ?? acsIso(r.B)) ?? [] })).filter(h => h.matches.length);

  // -- join 2: police case number
  const regPolice = new Set(recs.map(r => at(r).police_report_number).filter(Boolean));
  const acsPolice = data.map(r => r.AK).filter(v => v && !/^n\/?a$/i.test(v));
  const policeHits = acsPolice.filter(v => regPolice.has(v));

  // -- join 3: coordinates -> nearest asset, and nearest register record
  const COORD = /([+-]?2[5-7]\.\d{3,})\s*,\s*([+-]?-?8[01]\.\d{3,})/;
  const m2 = (a, b) => Math.hypot((a.longitude - b.longitude) * 111320
    * Math.cos(a.latitude * Math.PI / 180), (a.latitude - b.latitude) * 110540);
  const coordRows = [];
  for (const r of data) {
    const m = COORD.exec(r.J ?? ''); if (!m) continue;
    const p = { latitude: +m[1], longitude: +m[2] };
    let bestA = null;
    for (const [id, a] of assets) { const d = m2(p, a);
      if (!bestA || d < bestA.d) bestA = { id, d: Math.round(d), category: a.category }; }
    let bestR = null;
    for (const rec of recs) { const a = assets.get(at(rec).damaged_asset_id); if (!a) continue;
      const d = m2(p, a); if (!bestR || d < bestR.d) bestR = { code: at(rec).code, d: Math.round(d),
        date: iso(at(rec).incident_date) }; }
    coordRows.push({ task: r.A, acsDate: acsIso(r.L) ?? acsIso(r.B), nearestAsset: bestA, nearestIncident: bestR });
  }

  return {
    register: { count: recs.length, from: regDates[0], to: regDates[regDates.length - 1],
      codeSample: recs.slice(0, 3).map(r => at(r).code),
      policeSample: [...regPolice].slice(0, 3) },
    liveIds: live.map(r => r.id),
    acs: { rows: data.length, from: acsDates[0], to: acsDates[acsDates.length - 1] },
    dayOverlap: { acsRowsWithARegisterRecordThatDay: dayHits.length, examples: dayHits.slice(0, 4) },
    policeNumberMatches: policeHits.length,
    acsPoliceFormats: [...new Set(acsPolice)].slice(0, 8),
    coordRows: coordRows.slice(0, 8),
  };
}, acs), null, 1));
await browser.close();
