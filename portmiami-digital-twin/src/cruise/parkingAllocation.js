/**
 * Which garages a cruise terminal's passengers park in, and how many spaces each one has.
 *
 * THE MAPPING IS THE COUNTY'S, NOT A GUESS. Every parking record in the registry carries
 * `servesAssetIds`, read from the county parking page — Garage G serves terminals F, G and V,
 * Garages J and K serve J, and so on. Nothing here assigns a garage to a terminal because it is
 * nearby. Where the page names no facility for a terminal (the report's "AAA", Terminal V's only
 * facility being shared), that terminal is reported as unmapped or shared, never filled in.
 *
 * THE SPLIT IS AN ASSUMPTION. Where a terminal has more than one facility (D: Garage D and Surface
 * Lot D), the county does not say how passengers divide between them. The default divides by
 * published capacity, is labelled ASSUMED, and is editable.
 *
 * CAPACITY IS PUBLISHED OR UNKNOWN. Spaces come from the registry's Table 1-3 transcription; a
 * facility the table does not list (Garage AA) has capacity `null` and is never given one.
 */
import { PROPOSED_SCOPE } from './cruiseAssumptions.js';

/** Registry parking facilities as simulation facilities. */
export function registryFacilities(assets) {
  const codeOf = id => String(id ?? '').replace(/^terminal-/, '').toUpperCase();
  return (assets ?? [])
    .filter(asset => asset.category === 'PARKING')
    .map(asset => ({
      id: asset.id,
      name: asset.name,
      kind: /surface/i.test(asset.name) ? 'SURFACE_LOT' : 'GARAGE',
      capacity: asset.attributes?.capacity?.spaces ?? null,
      capacitySource: asset.attributes?.capacity ? 'PUBLISHED (2050 Master Plan, Table 1-3)' : null,
      servesTerminals: (asset.attributes?.servesAssetIds ?? []).map(codeOf),
      proposed: false,
      scope: PROPOSED_SCOPE.OWN_TERMINALS,
      addedSpaces: 0,
    }));
}

/**
 * The default terminal allocation: for each terminal, the facilities the county says serve it,
 * split in proportion to published capacity (equally where none is published).
 *
 * @returns {Record<string, {facilityId: string, sharePct: number}[]>}
 */
export function defaultAllocations(facilities, terminalCodes) {
  const out = {};
  for (const code of terminalCodes) {
    const serving = facilities.filter(f => !f.proposed && f.servesTerminals.includes(code));
    if (!serving.length) { out[code] = []; continue; }
    const known = serving.every(f => Number.isFinite(f.capacity));
    const weights = serving.map(f => (known ? f.capacity : 1));
    const total = weights.reduce((s, w) => s + w, 0);
    // Whole percentages that add to exactly 100: largest remainder.
    const raw = weights.map(w => (w / total) * 100);
    const shares = raw.map(Math.floor);
    let left = 100 - shares.reduce((s, v) => s + v, 0);
    raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1])
      .forEach(([, i]) => { if (left > 0) { shares[i] += 1; left -= 1; } });
    out[code] = serving.map((f, i) => ({ facilityId: f.id, sharePct: shares[i] }));
  }
  return out;
}

/** Problems with an allocation, as sentences: shares that do not add to 100, unknown facilities. */
export function validateAllocations(allocations, facilities) {
  const ids = new Set(facilities.map(f => f.id));
  const errors = [];
  for (const [code, rows] of Object.entries(allocations ?? {})) {
    if (!rows.length) continue;
    const sum = rows.reduce((s, r) => s + Number(r.sharePct || 0), 0);
    if (Math.abs(sum - 100) > 0.01) errors.push(`Terminal ${code}: shares add up to ${sum}%, not 100%.`);
    for (const r of rows) if (!ids.has(r.facilityId)) errors.push(`Terminal ${code}: unknown facility ${r.facilityId}.`);
  }
  return errors;
}

/**
 * The facilities one scenario simulates against: the registry's, with that scenario's spaces.
 *
 *   EXPAND_EXISTING  the selected garage gains its additional spaces
 *   NEW_GARAGE       a proposed facility with the additional spaces
 *   OPTIMIZE_SURFACE the selected surface lot gains them; a picked site becomes a proposed facility
 *   BASELINE         unchanged
 *
 * `scope` says which demand the proposed spaces may take: only from the terminals that facility
 * already serves (OWN_TERMINALS), overflow from any terminal (ANY_TERMINAL), or overflow from a
 * configured list of terminal codes (an array). A proposed facility defaults to an empty list. It is a stated planning assumption per scenario,
 * because no source says which terminals a garage that does not exist would serve; a terminal
 * not in the list cannot use the spaces, so they cannot solve its shortage.
 */
export function scenarioFacilities(base, scenario, { scopeFor = {} } = {}) {
  const facilities = base.map(f => ({ ...f }));
  if (!scenario || scenario.type === 'BASELINE') return facilities;
  const byId = new Map(facilities.map(f => [f.id, f]));
  // Which terminals may use the added spaces. Spaces added to a registered facility default to
  // its own terminals; a facility that does not exist yet serves NO terminal until one is
  // configured — no source says which terminals it would serve, so none is assumed.
  const configured = scopeFor[scenario.type];
  const grow = (target, added) => {
    target.addedSpaces = (target.addedSpaces ?? 0) + added;
    target.existingCapacity = Number.isFinite(target.capacity) ? target.capacity - (target.addedSpaces - added) : null;
    // Unknown existing capacity stays unknown: the added spaces cannot make a total out of nothing.
    target.capacity = Number.isFinite(target.capacity) ? target.capacity + added : null;
    target.scope = configured ?? PROPOSED_SCOPE.OWN_TERMINALS;
  };

  // C across several lots: each lot gains its own spaces.
  if (scenario.type === 'OPTIMIZE_SURFACE' && Array.isArray(scenario.lotAdditions) && scenario.lotAdditions.length) {
    for (const lot of scenario.lotAdditions) {
      const target = byId.get(lot.assetId);
      const added = Number(lot.additionalSpaces) || 0;
      if (target && added > 0) grow(target, added);
    }
    return facilities;
  }
  const added = Number(scenario.assumptions?.additionalSpaces) || 0;
  if (added <= 0) return facilities;
  const target = byId.get(scenario.site?.assetId);
  if ((scenario.type === 'EXPAND_EXISTING' || scenario.type === 'OPTIMIZE_SURFACE') && target) {
    grow(target, added);
    return facilities;
  }
  if (scenario.type === 'EXPAND_EXISTING') return facilities;   // no garage chosen: nothing to expand
  facilities.push({
    id: `proposed-${scenario.key ?? scenario.id}`,
    name: scenario.type === 'NEW_GARAGE' ? `Proposed new garage (${scenario.key ?? 'B'})` : `Proposed surface parking (${scenario.key ?? 'C'})`,
    kind: scenario.type === 'NEW_GARAGE' ? 'GARAGE' : 'SURFACE_LOT',
    capacity: added,
    existingCapacity: 0,
    capacitySource: 'SCENARIO ASSUMPTION',
    servesTerminals: [],
    proposed: true,
    scope: configured ?? [],
    addedSpaces: added,
  });
  return facilities;
}

// ---- terminal → garage mapping ------------------------------------------------------------------------

/** How a terminal's cars are divided among its eligible garages. */
export const ALLOCATION_POLICY = Object.freeze({
  PROPORTIONAL: 'PROPORTIONAL',   // split by each mapping's share, then spill to the others by priority
  PRIORITY: 'PRIORITY',           // fill garages in priority order
});

export const ALLOCATION_POLICY_LABEL = Object.freeze({
  PROPORTIONAL: 'Split by share, then spill by priority',
  PRIORITY: 'Fill garages in priority order',
});

export const MAPPING_SOURCE = Object.freeze({
  COUNTY_PARKING_PAGE: 'COUNTY_PARKING_PAGE',
  USER_CONFIGURED: 'USER_CONFIGURED',
});

export const MAPPING_SOURCE_LABEL = Object.freeze({
  COUNTY_PARKING_PAGE: 'County parking page (PortMiami)',
  USER_CONFIGURED: 'Configured in this app',
});

/**
 * The persistent terminal → garage mapping: one row per pair, including pairs whose access has
 * been turned off, so a review never loses a row. Defaults come only from the registry's
 * `servesAssetIds` (the county parking page) — never from proximity. Priority defaults to larger
 * published capacity first, then facility id, so it is deterministic; the share defaults to the
 * capacity split of `defaultAllocations`.
 *
 * @returns {{ terminal_id, terminal_code, garage_id, access_allowed, allocation_priority,
 *   share_pct, max_share_pct, access_route_id, mapping_source, verification_status }[]}
 */
export function defaultTerminalGarageMapping(facilities, terminalCodes) {
  const shares = defaultAllocations(facilities, terminalCodes);
  return terminalCodes.flatMap(code => {
    const rows = shares[code] ?? [];
    const ranked = rows.map(r => facilities.find(f => f.id === r.facilityId))
      .sort((a, b) => (b.capacity ?? -1) - (a.capacity ?? -1) || a.id.localeCompare(b.id));
    return ranked.map((f, i) => ({
      terminal_id: `terminal-${code.toLowerCase()}`,
      terminal_code: code,
      garage_id: f.id,
      access_allowed: true,
      allocation_priority: i + 1,
      share_pct: rows.find(r => r.facilityId === f.id).sharePct,
      max_share_pct: null,
      access_route_id: null,
      mapping_source: MAPPING_SOURCE.COUNTY_PARKING_PAGE,
      verification_status: 'PUBLISHED',
    }));
  });
}

/**
 * The mapping as the simulation reads it: for each terminal, its ALLOWED garages in priority
 * order (ties by garage id), with share and cap. A terminal with none allowed maps to [] and its
 * cars are unallocated — never sent to the rest of the port.
 */
export function allocationsFromMapping(mapping, terminalCodes = []) {
  const out = Object.fromEntries(terminalCodes.map(code => [code, []]));
  for (const r of mapping) {
    if (!r.access_allowed) continue;
    (out[r.terminal_code] ??= []).push({
      facilityId: r.garage_id,
      sharePct: Number(r.share_pct) || 0,
      priority: Number(r.allocation_priority) || 99,
      maxSharePct: r.max_share_pct === null || r.max_share_pct === '' || r.max_share_pct === undefined ? null : Number(r.max_share_pct),
      accessRouteId: r.access_route_id ?? null,
    });
  }
  for (const code of Object.keys(out)) out[code].sort((a, b) => a.priority - b.priority || a.facilityId.localeCompare(b.facilityId));
  return out;
}

/** Problems with a mapping, as sentences, each naming the terminal and garage. */
export function validateMapping(mapping, facilities, policy = ALLOCATION_POLICY.PROPORTIONAL) {
  const ids = new Set(facilities.map(f => f.id));
  const errors = [];
  const seen = new Set();
  for (const r of mapping) {
    const key = `${r.terminal_code}|${r.garage_id}`;
    if (seen.has(key)) errors.push(`Terminal ${r.terminal_code} lists ${r.garage_id} twice.`);
    seen.add(key);
    if (!ids.has(r.garage_id)) errors.push(`Terminal ${r.terminal_code}: unknown garage ${r.garage_id}.`);
    if (!(Number(r.allocation_priority) >= 1)) errors.push(`Terminal ${r.terminal_code} → ${r.garage_id}: priority must be 1 or more.`);
    const max = r.max_share_pct;
    if (max !== null && max !== '' && max !== undefined && !(Number(max) > 0 && Number(max) <= 100)) errors.push(`Terminal ${r.terminal_code} → ${r.garage_id}: maximum share must be between 1% and 100%.`);
    if (Number(r.share_pct) < 0 || Number(r.share_pct) > 100) errors.push(`Terminal ${r.terminal_code} → ${r.garage_id}: share must be between 0% and 100%.`);
  }
  if (policy === ALLOCATION_POLICY.PROPORTIONAL) {
    const codes = [...new Set(mapping.map(r => r.terminal_code))];
    for (const code of codes) {
      const allowed = mapping.filter(r => r.terminal_code === code && r.access_allowed);
      if (!allowed.length) continue;
      const sum = allowed.reduce((t, r) => t + Number(r.share_pct || 0), 0);
      if (Math.abs(sum - 100) > 0.01) errors.push(`Terminal ${code}: shares of its allowed garages add up to ${sum}%, not 100%.`);
    }
  }
  return errors;
}

/** Bring a saved mapping in line with the registry: keep the user's rows, add any new county rows. */
export function reconcileMapping(saved, facilities, terminalCodes) {
  const defaults = defaultTerminalGarageMapping(facilities, terminalCodes);
  if (!Array.isArray(saved)) return defaults;
  const key = r => `${r.terminal_code}|${r.garage_id}`;
  const have = new Set(saved.map(key));
  return [...saved.filter(r => facilities.some(f => f.id === r.garage_id)), ...defaults.filter(r => !have.has(key(r)))];
}
