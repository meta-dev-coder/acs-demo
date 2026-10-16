import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error' && !/live-dc-status|403|404/.test(m.text())) errors.push('console: ' + m.text()); });
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => window.__safetyIntel.analysis(), null, { timeout: 120000 });
await page.waitForTimeout(3000);

const snap = async l => page.evaluate(label => {
  const si = window.__safetyIntel;
  const a = si.analysis();
  return { label,
    sel: si.selection.selectionType, selLabel: si.selection.label, scope: si.selection.scope,
    sectionId: si.selection.sectionId, mode: si.rightMode,
    scopedLabel: a?.scoped.label, scopedRecords: a?.scoped.facts.length,
    sections: a?.sections.rows.length, corridorRate: a?.sections.corridorPerHundredMillionVmt,
    topSection: a?.sections.rows[0] && { id: a.sections.rows[0].id, rate: a.sections.rows[0].perHundredMillionVmt, records: a.sections.rows[0].records },
    unassigned: a?.sections.unassigned.facts.length,
    invRecs: a?.investigation?.recommendations.length ?? null,
    invRecord: a?.investigation?.record ? a.investigation.record.recorded.type : null,
    invSummary: a?.investigation?.summary && { records: a.investigation.summary.records, rate: a.investigation.summary.perHundredMillionVmt, openDefects: a.investigation.summary.openDefects },
    queueTotal: a?.queue.total, byAction: a?.queue.byAction,
    investigationVisible: !document.querySelector('[data-region="investigation"]').hidden,
    queueVisible: !document.querySelector('[data-region="queue"]').hidden,
    recCards: document.querySelectorAll('.si-rec').length,
    sourceRows: document.querySelectorAll('.si-source').length,
  };
}, l);

console.log('1 arrival     ', JSON.stringify(await snap('arrival')));
await page.screenshot({ path: 'scratchpad/acc-1-arrival.png' });

// 3. select a section from the Accidents tab comparison
await page.click('.si-section-row');
await page.waitForTimeout(3000);
console.log('2 section     ', JSON.stringify(await snap('section')));
await page.screenshot({ path: 'scratchpad/acc-2-section.png' });

// 13. click an incident inside the investigation
const incident = await page.$('[data-incident]');
if (incident) { await incident.click(); await page.waitForTimeout(2500); }
console.log('3 incident    ', JSON.stringify(await snap('incident')));
await page.screenshot({ path: 'scratchpad/acc-3-incident.png' });

// 12. open a recommendation's supporting records
const sources = await page.$('.si-rec-sources summary');
if (sources) { await sources.click(); await page.waitForTimeout(600); }
console.log('4 evidence    ', JSON.stringify(await snap('evidence')));
await page.screenshot({ path: 'scratchpad/acc-4-evidence.png' });

// 14. back to corridor priorities, then 15. clear
await page.click('[data-mode="priorities"]');
await page.waitForTimeout(1200);
console.log('5 priorities  ', JSON.stringify(await snap('priorities')));
await page.click('.si-queue-item');
await page.waitForTimeout(3000);
console.log('6 fromQueue   ', JSON.stringify(await snap('fromQueue')));
await page.screenshot({ path: 'scratchpad/acc-5-queue.png' });
await page.click('[data-clear-selection]');
await page.waitForTimeout(2500);
console.log('7 cleared     ', JSON.stringify(await snap('cleared')));

// TMC regression
await page.selectOption('.app-role select', 'tmc');
await page.waitForTimeout(7000);
console.log('tmc:', JSON.stringify(await page.evaluate(() => ({
  section: document.body.dataset.section,
  tmcVisible: !document.querySelector('.tmc-workspace').hidden,
  siHidden: document.querySelector('.si-workspace').hidden,
}))));
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 10).join('\n') : 'no page errors');
await browser.close();
