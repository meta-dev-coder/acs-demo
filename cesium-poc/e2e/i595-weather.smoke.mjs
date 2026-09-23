import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openLayers } from './i595Explorer.mjs';
import { HOURLY, DAILY, WEATHER_URL, validateForecast, localHour, direction, number } from '../src/i595WeatherData.js';
const daily={time:[]},hourly={time:[]};for(const k of DAILY)daily[k]=[];for(const k of HOURLY)hourly[k]=[];
// The forecast is only treated as cached while its first day is today, so the fixture has to start
// on the current local date — hardcoding one made the test fail the moment the calendar rolled over.
const firstDay=localHour().slice(0,10);
for(let d=0;d<8;d++){
 const date=new Date(`${firstDay}T00:00:00Z`);date.setUTCDate(date.getUTCDate()+d);
 const iso=date.toISOString().slice(0,10);daily.time.push(iso);
 for(const k of DAILY)daily[k].push(k==='sunrise'?`${iso}T07:04`:k==='sunset'?`${iso}T19:29`:k==='daylight_duration'?44700:k.endsWith('max')?32:25);
 for(let h=0;h<24;h++){hourly.time.push(`${iso}T${String(h).padStart(2,'0')}:00`);for(const k of HOURLY)hourly[k].push(k==='temperature_2m'?27+Math.sin(h/24*Math.PI*2)*4:k==='relative_humidity_2m'?78:k==='precipitation'?0.2:k.includes('direction')?135:18.4);}
}
const fixture={timezone:'America/New_York',daily,hourly};validateForecast(fixture);
assert.equal(new URL(WEATHER_URL).searchParams.get('forecast_days'),'8');
assert.equal(localHour(new Date('2026-09-10T01:15:00Z')),'2026-09-09T21:00');
assert.equal(number(null),'—');assert.equal(direction(360),'N · 360°');
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});let requests=0,fail=false;
 await page.route('https://api.open-meteo.com/**',route=>{requests++;return fail?route.fulfill({status:503,body:'Unavailable'}):route.fulfill({json:fixture});});
 await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off');
 // The launcher is hidden in the map-focused view; the rail's weather tool is how it opens now.
 await openLayers(page);
 await page.locator('.quick-rail [data-action="weather"]').click();
 await page.locator('.weather-days button').first().waitFor();
 assert.equal(await page.locator('.weather-days button').count(),8);assert.equal(await page.locator('.weather-wind article').count(),4);
 await page.locator('[data-day="7"]').click();assert.equal(await page.locator('select[aria-label="Forecast hour"] option').count(),24);
 await page.locator('select[aria-label="Forecast hour"]').selectOption('180');assert.ok((await page.locator('.weather-hero').textContent()).includes('12:00'));
 await page.locator('[data-day="0"]').click();await page.screenshot({path:'/tmp/i595-weather-desktop.png'});
 await page.locator('.weather-close').click();await page.locator('.quick-rail [data-action="weather"]').click();assert.equal(requests,1);
 fail=true;await page.locator('.weather-refresh').click();await page.getByRole('status').filter({hasText:'Update failed'}).waitFor();assert.equal(await page.locator('.weather-days button').count(),8);
 fail=false;fixture.hourly.wind_speed_180m.fill(null);await page.locator('.weather-refresh').click();await page.getByRole('status').filter({hasText:/Updated/}).waitFor();assert.ok((await page.locator('.weather-wind article').last().textContent()).includes('—'));
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/i595-weather-mobile.png'});
 assert.ok(await page.locator('.weather-dialog').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
 await page.keyboard.press('Escape');assert.equal(await page.locator('.weather-dialog').evaluate(e=>e.open),false);// Focus comes back to whichever control is actually on screen — the launcher, or the rail tool
 // that replaces it in the map-focused view. It must never be left on <body>.
 assert.ok(await page.evaluate(()=>{const a=document.activeElement;return a && a!==document.body &&
   (a.classList.contains('weather-launch') || a.dataset.action==='weather');}), 'focus returns to a visible control');
 console.log('PASS: eight days, 24 hours per day, four wind heights, timezone, missing values, cache, refresh failure, mobile, keyboard close');
}finally{await browser.close();}
