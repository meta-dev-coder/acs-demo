/**
 * Ask the Twin on IFC versions: questions about what changed between two versions of the model are
 * answered from the existing comparison (server/ifcSpatial/compare.mjs through /api/ifc-spatial/
 * compare; cached on the server), never from the electrical inventory, and never with invented counts.
 *
 *  parseCompareQuestion  recognises a version question and what it asks for: the summary, a list
 *                        (added / removed / moved / modified, optionally of one asset category),
 *                        or one asset's change; with the versions named, "latest"/"previous", or the
 *                        context of the conversation (follow-ups: "those", "them", "one of them").
 *  compareAnswer         the answer's view model (answerView.js) from a comparison result.
 */
import { buildGroups, categoryOf, isSignificant, modificationClasses } from './changeGroups.js';

const STATUS_WORDS = [
  ['ADDED', /\b(added|new|introduced|appear(ed)?)\b/],
  ['REMOVED', /\b(removed|deleted|dropped|disappear(ed)?)\b/],
  ['MOVED', /\b(moved|relocated|changed location|change (their |its )?location|where did)\b/],
  ['MODIFIED', /\b(modified|modifications?|altered|updated)\b/],
];
const CATEGORY_WORDS = [
  ['breaker', /\b(circuit )?breakers?\b/], ['switchgear', /\bswitch ?gear|switchboards?|switches\b/], ['cable', /\bcables?|feeders?\b/],
  ['light', /\blights?|lighting|high[- ]mast/], ['transformer', /\btransformers?\b/], ['crane', /\bcranes?\b/], ['control', /\bscada|rtus?|controllers?\b/],
];
/** Category names for answers: [one, many]. */
const NOUNS = { breaker: ['circuit breaker', 'circuit breakers'], switchgear: ['switchgear', 'switchgear'], cable: ['cable', 'cables'], light: ['light', 'lights'],
  transformer: ['transformer', 'transformers'], crane: ['crane', 'cranes'], control: ['control device', 'control devices'] };
const VERSION = /\bv(?:ersion)?\s*\.?\s*(\d+)\b/gi;
const IS_VERSION_TALK = /\b(v\d+|versions?\s*\d+|versions?|latest (ifc|upload|version|model)|previous version|ifc upload|between the two)\b/i;
const IS_CHANGE_TALK = /\b(chang\w*|compar\w*|differ\w*|diff|added|new|removed|deleted|moved|relocat\w*|modif\w*)\b/i;
const FOLLOW_UP = /\b(those|them|these|they|one of them|of those|which of)\b/i;
const NETWORK_TALK = /\b(supply|supplies|supplied|power(ed)?|outage|fail|feed|upstream|downstream|connected|short[- ]circuit|interrupting|load|demand)\b/i;

/** The asset ids a question names, from a set of known ids (whole-word, longest first, case-insensitive). */
export function namedIds(question, ids) {
  const found = [];
  let q = ` ${question} `;
  for (const id of [...ids].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(^|[^A-Za-z0-9-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9-])`, 'i');
    if (re.test(q)) { found.push(id); q = q.replace(re, '$1 '); }
  }
  return found;
}

/**
 * A version question, or null. `context.cmp` is the conversation's last comparison ({base, target,
 * lastIds}); `knownIds` the asset ids of the model and of the comparison.
 */
export function parseCompareQuestion(question, { cmp = null, knownIds = new Set(), selectedId = null } = {}) {
  const q = String(question ?? '');
  const lower = q.toLowerCase();
  const versions = [...q.matchAll(VERSION)].map(m => Number(m[1]));
  const followUp = Boolean(cmp) && (FOLLOW_UP.test(lower) || /\b(show (me )?(the )?(new|added|removed|moved|modified)|newly added)\b/.test(lower)) && !NETWORK_TALK.test(lower);
  const changedIn = /\bwhat (has |was |were )?changed\b|\bchanges? (in|to|for|of)\b|\b(properties|property) changed\b|\bwhere did\b/i.test(q);
  // "were added", "was removed", "have been moved": change talk on its own.
  const changeVerb = /\b(were|was|have been|has been|got)\s+(added|removed|deleted|moved|relocated|modified)\b/i.test(q);
  // "Any recent changes to TX-M1?": about the newest version, for one asset.
  const recentAsset = /\b(any|recent|latest) (recent )?changes?\b|\bchanged recently\b/i.test(q) && namedIds(q, knownIds).length > 0;
  const isVersion = recentAsset || changeVerb || (IS_VERSION_TALK.test(q) && IS_CHANGE_TALK.test(q)) || (versions.length >= 1 && IS_CHANGE_TALK.test(q)) || (changedIn && !NETWORK_TALK.test(lower) && (cmp || versions.length)) || followUp;
  if (!isVersion) return null;
  const status = STATUS_WORDS.find(([, re]) => re.test(lower))?.[0] ?? null;
  const category = CATEGORY_WORDS.find(([, re]) => re.test(lower))?.[0] ?? null;
  const ids = namedIds(q, knownIds);
  const versionRef = versions.length >= 2 ? { base: Math.min(versions[0], versions[1]), target: Math.max(versions[0], versions[1]) }
    : versions.length === 1 ? { target: versions[0] }
    : /\blatest|newest|most recent|recent|current\b/.test(lower) ? { latest: true } : null;
  const onLast = Boolean(cmp) && FOLLOW_UP.test(lower);
  // Opening the comparison viewer needs map words ("show them", "on the map"), not just "show me the …".
  const wantsMap = /\b(on the map|on map|highlight|zoom (in )?(to|on)|focus on|show (them|those|these|it)\b)/.test(lower);
  const thisAsset = /\b(this|that|selected) (asset|element|one)\b|\bone of them\b/.test(lower);
  let kind = 'summary';
  if (ids.length === 1 || (thisAsset && selectedId)) kind = 'asset';
  else if (/\bone of them\b/.test(lower)) kind = 'pick';
  else if (status || category || onLast) kind = 'list';
  if (/\bhow many\b/.test(lower) && kind === 'list') kind = 'count';
  return { kind, status, category, assetId: ids[0] ?? (thisAsset ? selectedId : null), versionRef, onLast, wantsMap };
}

/** The versions a parsed question asks about, from the file's versions (newest first) and the context. */
export function resolveVersions(parsed, versionList, { cmp = null, active = null } = {}) {
  const numbers = versionList.map(v => v.versionNumber).filter(Number.isFinite).sort((a, b) => b - a);
  const has = n => numbers.includes(n);
  const ref = parsed.versionRef;
  if (ref?.base !== undefined) {
    const missing = [ref.base, ref.target].filter(n => !has(n));
    if (missing.length) return { error: `There is no version ${missing.map(n => `V${n}`).join(' or ')} of this model in ACC. Available: ${numbers.map(n => `V${n}`).join(', ')}.` };
    if (ref.base === ref.target) return { error: 'Name two different versions to compare.' };
    return { base: ref.base, target: ref.target, how: 'named' };
  }
  if (ref?.target !== undefined) {
    if (!has(ref.target)) return { error: `There is no version V${ref.target} of this model in ACC. Available: ${numbers.map(n => `V${n}`).join(', ')}.` };
    const prev = numbers.find(n => n < ref.target);
    if (prev === undefined) return { error: `V${ref.target} is the first version: there is nothing before it to compare with.` };
    return { base: prev, target: ref.target, how: 'previous' };
  }
  if (!ref?.latest && cmp) return { base: cmp.base, target: cmp.target, how: 'context' };
  if (!ref?.latest && active) return { base: active.base, target: active.target, how: 'active' };
  if (numbers.length < 2) return { error: 'This model has only one version in ACC: there is nothing to compare.' };
  return { base: numbers[1], target: numbers[0], how: 'latest' };
}

const fmtM = n => (Number.isFinite(n) ? `${n >= 100 ? Math.round(n) : n.toFixed(1)} m` : '—');
const fmtLL = g => (g ? `${g.lat.toFixed(6)}, ${g.lon.toFixed(6)}` : '—');
const idOf = c => c.networkId ?? c.name ?? c.globalId;
const STATUS_TEXT = { ADDED: 'added', REMOVED: 'removed', MOVED: 'moved', MODIFIED: 'modified' };
const TONE = { ADDED: 'ok', REMOVED: 'bad', MOVED: 'info', MODIFIED: 'warn' };
const DOT = { ADDED: 'ok', REMOVED: 'bad', MOVED: 'warn', MODIFIED: 'warn' };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const article = (word, capital = false) => { const a = /^[aeiou]/i.test(word) ? 'an' : 'a'; return capital ? a[0].toUpperCase() + a.slice(1) : a; };

/** An item for a change: selecting it opens the comparison focused on that change. */
const changeItem = (c, base, target) => ({ id: idOf(c), label: idOf(c), dot: DOT[c.status], attrs: { 'data-cmp-open': `${base}:${target}`, 'data-cmp-focus': c.globalId } });

/**
 * The answer for a parsed question and its comparison `result` (the server's record: summary,
 * changes, statusUpdates, notes, warnings, base/target versions). Returns {view, ids}: the view
 * model and the change ids it is about (the next follow-up's "those").
 */
export function compareAnswer(parsed, result, { question, fileName, base, target, how, lastIds = null }) {
  const s = result.summary;
  const changes = result.changes ?? [];
  const sources = [`IFC comparison V${base} → V${target} of ${fileName} (computed on the server${result.computedAt ? ` ${new Date(result.computedAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}${result.cached ? ', cached' : ''})`];
  const openAll = { label: 'Open version comparison', primary: true, attrs: { 'data-cmp-open': `${base}:${target}` } };
  const resolved = how === 'latest' ? ` (the latest two versions of ${fileName})` : how === 'previous' ? ` (V${target} against the version before it)` : '';
  const kindLabel = 'Version comparison';

  if (parsed.kind === 'asset' || parsed.kind === 'pick') {
    if (parsed.kind === 'pick' || !parsed.assetId) {
      const pool = (lastIds ? changes.filter(c => lastIds.includes(c.globalId)) : changes).slice(0, 12);
      return { ids: pool.map(c => c.globalId), view: { question, kind: kindLabel, status: 'answered', title: 'Which one?',
        lead: `Name one of them, or choose: ${pool.length ? '' : 'there are none.'}`, sources,
        followUps: [], actions: pool.slice(0, 8).map(c => ({ label: idOf(c), attrs: { 'data-ask': `What changed in ${idOf(c)} between V${base} and V${target}?` } })) } };
    }
    const id = parsed.assetId;
    const c = changes.find(x => x.networkId === id || x.name === id || x.globalId === id);
    if (!c) {
      const status = (result.statusUpdates ?? []).find(u => u.networkId === id);
      return { ids: [], view: { question, kind: kindLabel, status: 'answered', title: `${id} is unchanged between V${base} and V${target}`,
        lead: status ? `Only its operational status changed (${status.changes.map(p => p.key.split('.').pop()).join(', ')}), which the comparison does not count as a design change.` : `The comparison found no difference in its placement, geometry, connections or properties${resolved}.`,
        sources, actions: [openAll] } };
    }
    const classes = [...modificationClasses(c)];
    const rows = [];
    if (c.status === 'MOVED') rows.push(`| Position | ${fmtLL(c.before?.geographic)} | ${fmtLL(c.after?.geographic)} |`);
    for (const m of c.modifications ?? []) {
      if (m.kind === 'properties') for (const p of m.changes) rows.push(`| ${p.key} | ${String(p.before ?? '—').replace(/\|/g, '/')} | ${String(p.after ?? '—').replace(/\|/g, '/')} |`);
      else if (m.kind === 'route') rows.push(`| Cable route | ${m.before} | ${m.after} |`);
      else if (m.kind === 'ports') rows.push(`| Connections (ports) | ${m.before} | ${m.after} |`);
      else if (m.kind === 'rotation') rows.push(`| Rotation | — | ${m.angleDeg}° |`);
      else if (m.kind === 'geometry') rows.push(`| Geometry | ${m.before?.triangles ?? '—'} triangles | ${m.after?.triangles ?? '—'} triangles |`);
    }
    const title = c.status === 'MOVED' ? `${id} moved ${fmtM(c.displacement?.distanceM)} between V${base} and V${target}`
      : c.status === 'ADDED' ? `${id} was added in V${target}` : c.status === 'REMOVED' ? `${id} was removed in V${target}`
      : `${id} was modified between V${base} and V${target}`;
    const lead = c.status === 'MOVED' ? `From ${fmtLL(c.before?.geographic)} to ${fmtLL(c.after?.geographic)} (horizontal ${fmtM(c.displacement?.horizontalM)})${c.modified ? `; it was also modified (${classes.filter(x => x !== 'placement').join(', ')})` : ''}.`
      : c.status === 'ADDED' ? `${article(c.ifcClass, true)} ${c.ifcClass} at ${fmtLL(c.after?.geographic)}.`
      : c.status === 'REMOVED' ? `It was ${article(c.ifcClass)} ${c.ifcClass} at ${fmtLL(c.before?.geographic)}.`
      : `Changed: ${classes.join(', ')}${(c.modifications ?? []).some(m => m.kind === 'properties') ? ` (${c.modifications.find(m => m.kind === 'properties').changes.length} properties)` : ''}.`;
    return { ids: [c.globalId], view: { question, kind: kindLabel, status: 'answered', title, lead, sources,
      bullets: (c.modifications ?? []).filter(m => m.kind !== 'properties').map(m => m.label),
      details: rows.length ? [{ title: `What changed · ${rows.length}`, markdown: `| | V${base} | V${target} |\n|---|---|---|\n${rows.join('\n')}` }, { title: 'Identity', items: [`IFC GlobalId ${c.globalId}`, `IFC class ${c.ifcClass}`, `Matched by ${c.match?.by === 'SECONDARY' ? `NetworkID/name (${Math.round(c.match.confidence * 100)}%)` : 'GlobalId'}`] }] : [],
      actions: [{ label: 'Show in the comparison', primary: true, attrs: { 'data-cmp-open': `${base}:${target}`, 'data-cmp-focus': c.globalId } }] } };
  }

  // Lists: by status, by category, or the last answer's set.
  let pool = changes;
  if (parsed.onLast && lastIds) pool = pool.filter(c => lastIds.includes(c.globalId));
  if (parsed.status) pool = pool.filter(c => c.status === parsed.status);
  if (parsed.category) pool = pool.filter(c => categoryOf(c).key === parsed.category);
  if (parsed.kind === 'list' || parsed.kind === 'count') {
    // A follow-up on a set of one kind of change keeps its word ("added", not "changed").
    const kinds = new Set(pool.map(c => c.status));
    const statusWord = parsed.status ? STATUS_TEXT[parsed.status] : kinds.size === 1 ? STATUS_TEXT[[...kinds][0]] : 'changed';
    const [one, many] = parsed.category ? NOUNS[parsed.category] : ['asset', 'assets'];
    const by = new Map();
    for (const c of pool) { const k = categoryOf(c).many; by.set(k, (by.get(k) ?? 0) + 1); }
    let lead = pool.length ? [...by].map(([k, n]) => `${n} ${n === 1 ? k.replace(/s$/, '') : k}`.toLowerCase()).join(', ') + '.' : '';
    if (!pool.length && parsed.category) {
      // Nothing of that category: say what there is instead.
      const others = changes.filter(c => !parsed.status || c.status === parsed.status);
      const k = new Map(); for (const c of others) k.set(categoryOf(c).many, (k.get(categoryOf(c).many) ?? 0) + 1);
      lead = others.length ? `The ${statusWord} assets are: ${[...k].map(([n, v]) => `${v} ${n.toLowerCase()}`).join(', ')}.` : '';
    }
    const groups = buildGroups(pool).map(g => ({ label: g.label, tone: TONE[g.status], total: g.members.length, items: g.members.map(c => changeItem(c, base, target)) }));
    const focusIds = pool.map(c => c.globalId).join(',');
    const title = pool.length ? `${plural(pool.length, one, many)} ${statusWord} between V${base} and V${target}` : `No ${many} ${statusWord} between V${base} and V${target}`;
    return { ids: pool.map(c => c.globalId), view: { question, kind: kindLabel, status: 'answered', title, lead: `${lead}${resolved && pool.length ? ` Compared${resolved}.` : ''}`, groups: parsed.kind === 'count' && pool.length > 8 ? groups.map(g => ({ ...g, items: g.items })) : groups, sources,
      actions: pool.length ? [{ label: 'Show on map', primary: true, attrs: { 'data-cmp-open': `${base}:${target}`, 'data-cmp-ids': focusIds } }, openAll] : [openAll],
      followUps: pool.length > 1 ? [{ label: 'One of them in detail', question: 'What changed in one of them?' }] : [] } };
  }

  // The summary: counts, groups, what dominates.
  const groups = buildGroups(changes);
  const significant = changes.filter(isSignificant).length;
  const propertyOnly = changes.length - significant;
  const parts = [s.added && `${s.added} added`, s.moved && `${s.moved} moved`, s.modified && `${s.modified} modified`, s.removed && `${s.removed} removed`].filter(Boolean);
  const lead = !s.total ? `No design differences${resolved}${(result.statusUpdates ?? []).length ? `; ${plural(result.statusUpdates.length, 'operational status update')}, not counted as design changes` : ''}.`
    : `${parts.join(', ')}${resolved ? `, comparing${resolved}` : ''}. ${significant} ${significant === 1 ? 'is' : 'are'} significant (added, removed, moved, geometry or connection changes)${propertyOnly ? `; ${propertyOnly} only changed properties` : ''}.`;
  return { ids: changes.map(c => c.globalId), view: { question, kind: kindLabel, status: 'answered',
    title: s.total ? `${plural(s.total, 'change')} between V${base} and V${target}` : `No changes between V${base} and V${target}`, lead, sources,
    metrics: [{ label: 'Added', value: s.added, tone: 'ok' }, { label: 'Moved', value: s.moved, tone: 'info' }, { label: 'Modified', value: s.modified, tone: 'warn' }, { label: 'Removed', value: s.removed, tone: 'bad' }, { label: 'Unchanged', value: s.unchanged, tone: 'neutral' }],
    groups: groups.map(g => ({ label: `${g.label}${g.significant ? '' : ' (properties only)'}`, tone: TONE[g.status], total: g.members.length, items: g.members.map(c => changeItem(c, base, target)) })),
    details: [
      { title: 'Notes from the comparison', items: [...(result.notes ?? []), ...(result.warnings ?? []), ...(result.modelWide ?? []).map(g => `Model-wide: ${g.label}.`)] },
      { title: 'Operational updates (not counted)', items: (result.statusUpdates ?? []).map(u => `${u.networkId ?? u.name}: ${u.changes.map(p => `${p.key.split('.').pop()} ${p.before ?? '—'} → ${p.after ?? '—'}`).join('; ')}`) },
    ],
    actions: [openAll, ...(s.added ? [{ label: 'Show added assets', attrs: { 'data-cmp-open': `${base}:${target}`, 'data-cmp-status': 'ADDED' } }] : []),
      ...(s.modified ? [{ label: 'Show modified assets', attrs: { 'data-cmp-open': `${base}:${target}`, 'data-cmp-status': 'MODIFIED' } }] : [])],
    followUps: [s.added && { label: 'Which were added?', question: `Which assets were added in V${target}?` }, s.moved && { label: 'What moved?', question: `Which equipment moved between V${base} and V${target}?` }].filter(Boolean) } };
}
