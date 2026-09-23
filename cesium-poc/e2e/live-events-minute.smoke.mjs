import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const captured = {
    "source": "FL511",
    "sourceStatus": "LIVE",
    "lastUpdated": "2026-09-23T10:18:57.780Z",
    "lastSuccessfulUpdate": "2026-09-23T10:18:57.780Z",
    "dataFreshness": {
      "ageSeconds": 4,
      "refreshSeconds": 60,
      "staleAfterSeconds": 180
    },
    "bufferMeters": 250,
    "segmentToleranceMeters": 120,
    "counts": {
      "total": 1,
      "incidents": 1,
      "closures": 0
    },
    "events": [
      {
        "id": "FL511-INCIDENT-868702",
        "source": "FL511",
        "type": "INCIDENT",
        "latitude": 26.093417,
        "longitude": -80.226583,
        "detailsAvailable": true,
        "detailFields": [
          {
            "label": "Severity",
            "value": "Intermediate"
          },
          {
            "label": "Region",
            "value": "Southeast"
          },
          {
            "label": "Start Time",
            "value": "Sep 23 2026, 5:53 AM"
          },
          {
            "label": "Last Updated",
            "value": "Sep 23 2026, 5:54 AM"
          }
        ],
        "distanceToI595NetworkM": 11.6,
        "nearestFacility": "I595_WB",
        "nearestFacilityLabel": "I-595 Westbound",
        "distanceToNearestFacilityM": 11.6,
        "nearestSegmentId": "I595-WB-FDOT-006680-007350",
        "nearestSegmentLabel": "Westbound Segment 4",
        "distanceToSegmentM": 11.6,
        "rawSourceId": "868702",
        "title": "Incident",
        "description": "Crash in Broward County on I-595 West, at Exit 7: Davie Rd. 2 Right lanes blocked. Last updated at 05:54 AM.",
        "severity": "Intermediate",
        "region": "Southeast",
        "startTime": "Sep 23 2026, 5:53 AM",
        "lastUpdated": "Sep 23 2026, 5:54 AM"
      }
    ],
    "diagnostics": {
      "lastError": null,
      "feeds": {
        "incidents": {
          "itemCount": 4,
          "lastSuccess": "2026-09-23T10:18:57.355Z",
          "error": null
        },
        "closures": {
          "itemCount": 7,
          "lastSuccess": "2026-09-23T10:18:56.965Z",
          "error": null
        }
      }
    }
  };
  await page.route('**/api/i595/live-events', route => route.fulfill({ json: captured }));
  const requests = [];
  page.on('request', r => { if (r.url().includes('/api/i595/live-events')) requests.push({ url: r.url(), time: Date.now() }); });
  await page.addInitScript(id => { window.__expectedIncidentId = id; }, captured.events.find(e => e.type === 'INCIDENT').id);
  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off');
  await page.locator('#live-events-incident:not(:disabled)').waitFor({ state: 'attached', timeout: 90000 });
  await page.locator('.app-nav [data-action="layers"]').click();
  await page.locator('.quick-rail [data-layer="incidents"]').click();
  await page.waitForFunction(() => window.__assetExplorer?.store.getState().assetsByType.incident?.some(a => a.id === window.__expectedIncidentId), null, { timeout: 20000 });
  assert.ok(requests.every(r => r.url.startsWith('http://127.0.0.1:5188/')));
  console.log('Captured incident loaded in the explorer through the local API route.');
  const before = requests.length;
  await page.waitForTimeout(62000);
  assert.ok(requests.length > before, 'API is polled again within one minute');
  const interval = requests.at(-1).time - requests.at(-2).time;
  assert.ok(interval >= 59000 && interval < 65000, `poll interval ${interval}`);
  console.log(`One-minute combined incident/closure refresh verified: ${interval} ms.`);
} finally { await browser.close(); }
