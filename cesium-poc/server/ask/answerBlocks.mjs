/**
 * Answer blocks (KPI tiles, bar lists, tables, a trend line) and per-ref evidence, built from the
 * lookups an answer cites. The model never writes a figure into a block: each value is copied from a
 * cited lookup's output, so what the panel draws is exactly what the twin returned.
 *
 * Blocks follow the panel contract in src/askTwinBlocks.js:
 *   kpi   {ref, label, value, unit?, note?}
 *   bars  {ref, title, items: [{label, value}]}
 *   table {ref, title, columns, rows, rowLocations?}
 *   trend {ref, title, unit?, points: [{t, value}]}
 */
const MAX_BLOCKS = 6;
const MAX_ROWS = 12;
const MAX_EVIDENCE = 10;

const num = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
const loc = r => (num(r?.lon) !== null && num(r?.lat) !== null ? { lon: num(r.lon), lat: num(r.lat) } : null);
const primitive = v => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** Blocks for one cited lookup. */
function blocksOf(call) {
  const o = call.output ?? {};
  const ref = call.ref;
  switch (call.name) {
    case 'count_records': {
      const out = [{ type: 'kpi', ref, label: o.groupBy ? `${o.className} (all groups)` : o.className, value: o.totalCount }];
      if (o.groups?.length > 1) out.push({ type: 'bars', ref, title: `${o.className} by ${o.groupBy}`, items: o.groups.slice(0, MAX_ROWS).map(g => ({ label: String(g.value ?? '(none)'), value: g.count })) });
      return out;
    }
    case 'records_near': {
      const out = [{ type: 'kpi', ref, label: `${o.className} within ${o.radius_m} m`, value: o.totalCount, note: o.anchor ?? undefined }];
      if (o.groups?.length > 1) out.push({ type: 'bars', ref, title: `By ${o.groupBy}`, items: o.groups.slice(0, MAX_ROWS).map(g => ({ label: String(g.value), value: g.count })) });
      return out;
    }
    case 'list_live_events': {
      const events = o.events ?? [];
      const out = [{ type: 'kpi', ref, label: 'Live events now', value: o.total ?? events.length }];
      if (events.length) out.push({ type: 'table', ref, title: 'Live events', columns: ['Event', 'Type', 'Near'],
        rows: events.slice(0, MAX_ROWS).map(e => [e.id, e.type, e.near ?? null]), rowLocations: events.slice(0, MAX_ROWS).map(loc) });
      return out;
    }
    case 'crash_hotspots': {
      const rows = o.hotspots ?? [];
      return rows.length ? [{ type: 'table', ref, title: `Crash hotspots${o.weather && o.weather !== 'any' ? ` (${o.weather})` : ''}`, columns: ['Section', 'Crashes', 'Wet', 'Closure h'],
        rows: rows.map(r => [r.section, r.crashes, r.wetCrashes, r.laneClosureHours]), rowLocations: rows.map(loc) }] : [];
    }
    case 'rank_incidents': {
      const rows = o.ranked ?? [];
      return rows.length ? [{ type: 'table', ref, title: 'Active incidents by risk', columns: ['#', 'Incident', 'Section', 'Score', 'Level'],
        rows: rows.map(r => [r.rank, r.id, r.section, r.score, r.level]), rowLocations: rows.map(loc) }] : [];
    }
    case 'explain_incident': {
      if (o.risk) return [{ type: 'kpi', ref, label: `Risk · ${o.incident?.id}`, value: o.risk.score, unit: '/100', note: `${o.risk.level} · rank ${o.risk.rank} of ${o.risk.of}` },
        ...(o.risk.drivers?.length ? [{ type: 'bars', ref, title: 'What drives the risk', items: o.risk.drivers.map(d => ({ label: d.factor, value: d.contribution })) }] : [])];
      if (o.section) return [{ type: 'kpi', ref, label: `Crashes on ${o.incident?.section}`, value: o.section.crashes, note: `rank ${o.section.rankOnCorridor} of ${o.section.of} sections` },
        { type: 'kpi', ref, label: 'Wet-weather share', value: Math.round((o.section.wetShare ?? 0) * 100), unit: '%', note: `corridor ${Math.round((o.section.corridorWetShare ?? 0) * 100)}%` }];
      return [];
    }
    case 'prioritize_sites': {
      const sites = o.sites ?? [];
      if (!sites.length) return [];
      const money = v => (v === null || v === undefined ? null : `$${Math.round(v).toLocaleString('en-US')}`);
      const moved = s => (s.moved === undefined ? null : s.moved > 0 ? `▲ ${s.moved}` : s.moved < 0 ? `▼ ${-s.moved}` : '—');
      const withRevenue = sites.some(s => s.revenue_at_risk_usd_per_day !== null && s.revenue_at_risk_usd_per_day !== undefined);
      const columns = ['#', 'Site', 'Open since', 'km', 'Risk', ...(withRevenue ? ['Revenue/day'] : []), ...(o.compared_with ? [`vs ${o.compared_label}`] : [])];
      const rows = sites.map(s => [s.rank, s.site, s.oldest_open_since, s.distance_km, s.inspection_risk,
        ...(withRevenue ? [money(s.revenue_at_risk_usd_per_day)] : []), ...(o.compared_with ? [moved(s)] : [])]);
      const out = [{ type: 'table', ref, title: `Fix order · ${o.preset_label}`, columns, rows, rowLocations: sites.map(loc) }];
      const top = sites[0];
      out.push({ type: 'bars', ref, title: `Why ${top.site} is first`, items: Object.entries(top.contributions ?? {}).filter(([, v]) => v !== null).map(([k, v]) => ({ label: k, value: v })) });
      return out;
    }
    case 'weather_risk_forecast': {
      const out = [];
      const hours = o.forecast?.hours ?? [];
      if (hours.length) out.push({ type: 'trend', ref, title: `Rain probability, ${o.window}`, unit: '%', points: hours.map(h => ({ t: h.time, value: h.rainProbability })) });
      if (o.segments?.length) out.push({ type: 'table', ref, title: 'Wet-weather crash history by section', columns: ['Section', 'Wet', 'Crashes', 'Wet share'],
        rows: o.segments.map(r => [r.section, r.wetCrashes, r.crashes, r.wetShare]), rowLocations: o.segments.map(loc) });
      return out;
    }
    default:
      return [];
  }
}

/** The records behind one lookup, for the evidence chip: id, a label, a position and a few fields. */
function recordsOf(call) {
  const o = call.output ?? {};
  const list = o.records ?? o.nearest ?? o.events ?? o.hotspots ?? o.ranked ?? o.sites ?? o.features ?? (o.incident ? [o.incident] : []);
  return list.slice(0, MAX_EVIDENCE).map(r => {
    const id = r.key ?? r.id ?? r.site ?? r.section ?? r.camera_id ?? r.name ?? null;
    const fields = Object.fromEntries(Object.entries(r).filter(([k, v]) => !['key', 'id', 'lon', 'lat', 'longitude', 'latitude', 'distance_m'].includes(k) && primitive(v) && v !== null).slice(0, 6));
    return { id: id === null ? null : String(id), label: r.title ?? r.type ?? r.incident_type ?? r.section ?? null, ...(loc(r) ?? (num(r.longitude) !== null ? { lon: num(r.longitude), lat: num(r.latitude) } : {})),
      ...(num(r.distance_m) !== null ? { distance_m: num(r.distance_m) } : {}), fields };
  });
}

/**
 * @param {object[]} calls   this turn's lookups (ref, name, output, source, evidence)
 * @param {string[]} cited   refs the answer cites
 * @returns {{blocks: object[], evidence: Record<string, object>}}
 */
export function buildAnswerExtras(calls, cited) {
  const byRef = new Map(calls.map(c => [c.ref, c]));
  const blocks = [];
  const evidence = {};
  for (const ref of cited) {
    const call = byRef.get(ref);
    if (!call?.evidence) continue;
    blocks.push(...blocksOf(call).filter(b => b.value !== undefined || b.type !== 'kpi'));
    const records = recordsOf(call);
    const o = call.output ?? {};
    evidence[ref] = { source: call.source, ...(call.summary ? { summary: call.summary } : {}),
      total: num(o.totalCount ?? o.total ?? o.activeIncidents) ?? records.length, records };
  }
  return { blocks: blocks.slice(0, MAX_BLOCKS), evidence };
}
