import { HEIGHTS, WEATHER_URL, validateForecast, number, direction, localHour } from './i595WeatherData.js';
import './i595Weather.css';
const esc = v => String(v ?? '—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dateLabel = d => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US',{timeZone:'UTC',weekday:'short',month:'short',day:'numeric'});
const clock = v => typeof v === 'string' && v.includes('T') ? v.slice(11,16) : '—';
export function installI595Weather() {
  const trigger = document.createElement('button'); trigger.className = 'weather-launch'; trigger.innerHTML = '<span aria-hidden="true">☀</span> Weather <span class="weather-preview">8-day outlook</span>'; trigger.setAttribute('aria-haspopup','dialog');
  const dialog = document.createElement('dialog'); dialog.className = 'weather-dialog'; dialog.setAttribute('aria-labelledby','weather-title');
  dialog.innerHTML = `<header><div><span class="weather-eyebrow">I-595 · BROWARD COUNTY</span><h2 id="weather-title">Weather Forecast</h2><p>26.0932° N, 80.1243° W · Florida local time</p></div><button class="weather-close" aria-label="Close weather">×</button></header><div class="weather-toolbar"><span class="weather-status" role="status">Forecast loads when opened</span><button class="weather-refresh">↻ Refresh</button></div><div class="weather-content"></div><footer>Forecast model data · °C / km/h / mm · <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Weather data by Open-Meteo</a></footer>`;
  document.body.append(trigger,dialog);
  let data, fetchedAt=0, pending, controller, disposed=false, day=0, hour=0;
  const content = dialog.querySelector('.weather-content'), status = dialog.querySelector('.weather-status'), refresh = dialog.querySelector('.weather-refresh');
  function render() {
    if (!data) return;
    const daily=data.daily, hourly=data.hourly, dates=daily.time.slice(0,8);
    day=Math.min(day,dates.length-1);
    const indices=hourly.time.map((t,i)=>t.startsWith(dates[day])?i:-1).filter(i=>i>=0);
    if(!indices.includes(hour)) hour=indices.find(i=>hourly.time[i]>=localHour()) ?? indices[0];
    const value = key => hourly[key]?.[hour];
    const temps=indices.map(i=>hourly.temperature_2m[i]).filter(Number.isFinite);
    const lo=Math.min(...temps)-2, span=Math.max(4,Math.max(...temps)-lo+2);
    // Separate paths across missing values; never draw invented zero temperatures.
    let pen=false;
    const path=indices.map((i,j)=>{const t=hourly.temperature_2m[i];if(!Number.isFinite(t)){pen=false;return '';}const point=`${20+j*760/Math.max(1,indices.length-1)},${110-(t-lo)/span*90}`;const part=`${pen?'L':'M'}${point}`;pen=true;return part;}).join(' ');
    const seconds=daily.daylight_duration[day];
    content.innerHTML = `<nav class="weather-days" aria-label="Forecast days">${dates.map((d,i)=>`<button data-day="${i}" aria-pressed="${i===day}"><span>${i===0?'Today':i===1?'Tomorrow':dateLabel(d).split(',')[0]}</span><small>${esc(dateLabel(d))}</small><strong>${number(daily.temperature_2m_max[i])}° <em>${number(daily.temperature_2m_min[i])}°</em></strong></button>`).join('')}</nav>
      <div class="weather-overview"><section class="weather-hero"><span class="weather-eyebrow">${esc(dateLabel(dates[day]))} · ${clock(hourly.time[hour])} FORECAST</span><div class="weather-temperature">${number(value('temperature_2m'))}<span>°C</span></div><p>Temperature at 2 m</p><div class="weather-range">High ${number(daily.temperature_2m_max[day])}° <span>Low ${number(daily.temperature_2m_min[day])}°</span></div></section><section class="weather-metrics"><article><span>Relative humidity · 2 m</span><strong>${number(value('relative_humidity_2m'))}<small> %</small></strong></article><article><span>Hourly precipitation</span><strong>${number(value('precipitation'),1)}<small> mm</small></strong></article><article><span>Wind · 10 m</span><strong>${number(value('wind_speed_10m'),1)}<small> km/h</small></strong><small>From ${direction(value('wind_direction_10m'))}</small></article></section></div>
      <section class="weather-hourly"><div class="weather-section-heading"><h3>Through the day</h3><label>Forecast hour <select aria-label="Forecast hour">${indices.map(i=>`<option value="${i}" ${i===hour?'selected':''}>${clock(hourly.time[i])}</option>`).join('')}</select></label></div><svg viewBox="0 0 800 130" role="img" aria-label="Hourly temperature trend in degrees Celsius"><path d="M20 112H780" stroke="#ffffff18"/><path d="${path}" fill="none" stroke="#6ee7d4" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg><div class="weather-hour-cards">${indices.map(i=>`<button data-hour="${i}" aria-pressed="${i===hour}"><small>${clock(hourly.time[i])}</small><strong>${number(hourly.temperature_2m[i])}°</strong><span>${number(hourly.precipitation[i],1)} mm</span></button>`).join('')}</div></section>
      <div class="weather-bottom"><section><h3>Wind by height</h3><p class="weather-note">${clock(hourly.time[hour])} · Direction the wind comes from</p><div class="weather-wind">${HEIGHTS.map(h=>`<article><span>${h} m</span><strong>${number(value(`wind_speed_${h}m`),1)} <small>km/h</small></strong><div>${direction(value(`wind_direction_${h}m`))}</div></article>`).join('')}</div></section><section class="weather-sun"><h3>Daylight</h3><div><span>↗ Sunrise</span><strong>${clock(daily.sunrise[day])}</strong></div><div><span>↘ Sunset</span><strong>${clock(daily.sunset[day])}</strong></div><div><span>Daylight duration</span><strong>${Number.isFinite(seconds)?`${Math.floor(seconds/3600)}h ${Math.floor(seconds%3600/60)}m`:'—'}</strong></div></section></div>`;
    content.querySelectorAll('[data-day]').forEach(b=>b.onclick=()=>{day=Number(b.dataset.day);render();});
    content.querySelectorAll('[data-hour]').forEach(b=>b.onclick=()=>{hour=Number(b.dataset.hour);const scroll=content.querySelector('.weather-hour-cards').scrollLeft;render();content.querySelector('.weather-hour-cards').scrollLeft=scroll;});
    content.querySelector('select').onchange=e=>{hour=Number(e.target.value);render();};
    trigger.querySelector('.weather-preview').textContent='Today + 7 days';
  }
  async function load(force=false) {
    if(pending)return pending;
    if(!force && data && Date.now()-fetchedAt<900000 && data.daily.time[0]===localHour().slice(0,10)){render();return;}
    refresh.disabled=true;status.textContent=data?'Updating forecast…':'Loading eight-day forecast…';
    if(!data)content.innerHTML='<div class="weather-loading">Connecting to the forecast…</div>';
    controller=new AbortController();const timer=setTimeout(()=>controller.abort(),15000);
    pending=(async()=>{try {
      const response=await fetch(WEATHER_URL,{signal:controller.signal});if(!response.ok)throw new Error('Weather unavailable');
      const next=validateForecast(await response.json());if(disposed)return;
      data=next;fetchedAt=Date.now();render();status.textContent=`Updated ${new Date(fetchedAt).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit'})} · America/New_York`;
    }catch(error){if(disposed)return;status.textContent=data?'Update failed · showing the previous forecast':'Forecast unavailable · try Refresh';if(!data)content.innerHTML='<div class="weather-loading">Unable to reach Open-Meteo. Please try again.</div>';}
    finally{clearTimeout(timer);pending=null;refresh.disabled=false;}})();return pending;
  }
  trigger.onclick=()=>{dialog.showModal();void load();};
  dialog.querySelector('.weather-close').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>trigger.focus());
  refresh.onclick=()=>void load(true);
  const interval=setInterval(()=>{if(dialog.open)void load();},900000);
  return {destroy(){disposed=true;controller?.abort();clearInterval(interval);dialog.remove();trigger.remove();}};
}
