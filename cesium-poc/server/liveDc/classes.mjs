/**
 * The "SDNA Florida I595 Live *" DataConnect classes: their definitions, the write allowlist, the
 * record validator and the diff helpers every Live DataConnect module shares. Live classes are
 * separate from Bentley's historical classes so a live sync can never touch historical data; the
 * historical definitions here are read-only references. Pure Node, so the AWS poller can import it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const readConfig = (name) => JSON.parse(readFileSync(new URL(`../../config/liveDc/${name}`, import.meta.url), 'utf8'));
const LIVE_CONFIG = readConfig('liveClasses.json');
const HISTORICAL_CONFIG = readConfig('historicalClasses.json');
const SEGMENT_CONFIG = readConfig('dcSegments.json');

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};
const clone = (value) => structuredClone(value);

// A Set that refuses mutation, so the allowlists cannot be widened at runtime.
const frozenSet = (values) => {
  const set = new Set(values);
  for (const method of ['add', 'delete', 'clear']) {
    Object.defineProperty(set, method, { value: () => { throw new TypeError('frozen set'); } });
  }
  return Object.freeze(set);
};

export const LIVE_CLASS = Object.freeze(Object.fromEntries(LIVE_CONFIG.classes.map((c) => [c.key, c.className])));
export const LIVE_CLASS_NAMES = Object.freeze(LIVE_CONFIG.classes.map((c) => c.className));
export const REF = Object.freeze({ ASSETS: 'Florida I595 Assets', SEGMENTS: 'Florida i595 Roadway Segments' });
export const HISTORICAL_CLASSES = deepFreeze(HISTORICAL_CONFIG);
export const HISTORICAL_CLASS_IDS = frozenSet(HISTORICAL_CLASSES.map((c) => c.id));
export const HISTORICAL_NUMERIC_CLASS_IDS = frozenSet(HISTORICAL_CLASSES.map((c) => c.classId));
export const PROJECT_CODE = '2222FL';
export const DC_SEGMENT_CODES = Object.freeze([...SEGMENT_CONFIG.codes]);
export const LINK_MODES = Object.freeze(['live', 'linked', 'none']);
export const LIVE_RELATIONSHIP_TYPES = deepFreeze(clone(LIVE_CONFIG.relationshipTypes));

const LIVE_NAME_SET = new Set(LIVE_CLASS_NAMES);
const HISTORICAL_ID_BY_NAME = new Map(HISTORICAL_CLASSES.map((c) => [c.className, c.id]));
const STRING_LIKE = new Set(['String', 'Date', 'DateTime', 'Timestamp', 'URL']);
const CORE_NAMES = new Set(LIVE_CONFIG.coreAttributes.map((a) => a.name));

export function isLiveClassName(name) {
  return typeof name === 'string' && LIVE_NAME_SET.has(name);
}

const assertLinkMode = (linkMode) => {
  if (!LINK_MODES.includes(linkMode)) throw new Error(`unknown linkMode '${linkMode}'`);
};

const attributeDef = ({ name, displayName = name, description = '', type = 'String' }, core) => ({
  name, displayName, description, type, mandatory: core, array: false, core, displayInExplorer: true, openInIframe: false,
});

const resolveAttribute = (spec, linkMode) => {
  const entry = typeof spec === 'string' ? (LIVE_CONFIG.commonAttributes[spec] ?? { name: spec }) : spec;
  const attr = attributeDef(entry, false);
  const isRelationship = entry.relatedClassName && linkMode !== 'none' && (!entry.linkedOnly || linkMode === 'linked');
  if (isRelationship) {
    Object.assign(attr, { relatedClassName: entry.relatedClassName, relatedAttributeName: 'code', relationshipType: entry.relationshipType });
  }
  return attr;
};

const buildDefinition = (cls, linkMode) => ({
  key: cls.key,
  className: cls.className,
  description: cls.description,
  geometryAttributeName: 'geometry',
  attributes: [
    ...LIVE_CONFIG.coreAttributes.map((a) => attributeDef(a, true)),
    ...cls.attributes.map((spec) => resolveAttribute(spec, linkMode)),
  ],
});

export function liveClassDefinitions({ linkMode = 'live' } = {}) {
  assertLinkMode(linkMode);
  return LIVE_CONFIG.classes.map((cls) => buildDefinition(cls, linkMode));
}

export function liveClassDefinition(className, { linkMode = 'live' } = {}) {
  assertLinkMode(linkMode);
  const cls = LIVE_CONFIG.classes.find((c) => c.className === className);
  if (!cls) throw new Error(`not a Live class: '${className}'`);
  return buildDefinition(cls, linkMode);
}

export function placeholderObjectId(className) {
  return createHash('sha1').update(`live-dc:${className}`).digest('hex').slice(0, 24);
}

const isRelationship = (attr) => Boolean(attr.relatedClassName || attr.relatedClassId);

export function relationshipAttributes(defOrDto) {
  return (defOrDto?.attributes ?? []).filter(isRelationship);
}

const resolvedAttribute = (attr, resolveClassId) => {
  const { relatedClassName, ...rest } = clone(attr);
  if (!relatedClassName) return rest;
  const relatedClassId = resolveClassId(relatedClassName);
  if (typeof relatedClassId !== 'string' || !relatedClassId) throw new Error(`cannot resolve class id of '${relatedClassName}'`);
  return { ...rest, relatedClassId };
};

const requireResolver = (resolveClassId) => {
  if (typeof resolveClassId !== 'function') throw new Error('resolveClassId is required');
  return resolveClassId;
};

export function toClassDto(def, { id, classId, resolveClassId, now = 0 }) {
  requireResolver(resolveClassId);
  // DataConnect timestamps carry no zone suffix.
  const stamp = new Date(now).toISOString().slice(0, -1);
  return {
    id, classId, className: def.className, classType: 'DATA_CLASS', description: def.description, status: 'Published',
    owners: [], createdBy: 'live-dc', lastModifiedBy: 'live-dc', createdOn: stamp, lastUpdated: stamp,
    geometryAttributeName: 'geometry', displayInExplorer: true, includeSecuritySettings: false, securityLevel: 0, parentId: null,
    attributes: def.attributes.map((a) => resolvedAttribute(a, resolveClassId)),
  };
}

export function buildCreateRequests({ resolveClassId, linkMode = 'live' } = {}) {
  requireResolver(resolveClassId);
  return liveClassDefinitions({ linkMode }).map((def) => ({
    className: def.className,
    create: {
      className: def.className, description: def.description, status: 'Published', owners: [], classType: 'DATA_CLASS',
      displayInExplorer: true, includeSecuritySettings: false,
    },
    update: {
      className: def.className, description: def.description, owners: [], displayInExplorer: true, includeSecuritySettings: false,
      geometryAttributeName: 'geometry',
      add: def.attributes.filter((a) => !a.core).map((a) => resolvedAttribute(a, resolveClassId)),
      modify: [], remove: [],
    },
  }));
}

const RELATIONSHIP_TYPES_NOTE = 'ADDITIVE delta for the global relationship-type registry. GET /api/data-mgmt/v1/relationship-types, '
  + 'append these entries to the existing list (never remove or rename existing types), PUT with the current version. '
  + 'DataConnect requires order in 1..total: renumber each entry as existingCount + order. '
  + "Skip entirely when using link mode 'none'.";

export function buildRelationshipTypesDelta({ linkMode = 'live', existingCount = 0 } = {}) {
  assertLinkMode(linkMode);
  const types = linkMode === 'none' ? [] : LIVE_RELATIONSHIP_TYPES.filter((t) => linkMode === 'linked' || !t.linkedOnly);
  return {
    note: RELATIONSHIP_TYPES_NOTE,
    relationshipTypes: types.map(({ type, externalLabel, internalLabel }, i) => ({ type, externalLabel, internalLabel, order: existingCount + i + 1 })),
  };
}

function defaultReferenceResolver(className) {
  if (HISTORICAL_ID_BY_NAME.has(className)) return HISTORICAL_ID_BY_NAME.get(className);
  if (isLiveClassName(className)) return placeholderObjectId(className);
  throw new Error(`unknown relationship target class '${className}'`);
}

const REFERENCE_ATTRIBUTE_KEYS = ['name', 'displayName', 'description', 'type', 'mandatory', 'core', 'array',
  'relatedClassId', 'relatedAttributeName', 'relationshipType'];

export function buildClassReference({ resolveClassId = defaultReferenceResolver, linkMode = 'live' } = {}) {
  return {
    _note: 'REFERENCE DOCUMENT ONLY - not a payload for /admin/data/import; create classes with live-classes.create-requests.json',
    linkMode,
    classes: liveClassDefinitions({ linkMode }).map((def) => ({
      id: resolveClassId(def.className),
      className: def.className, classType: 'DATA_CLASS', description: def.description, status: 'Published',
      geometryAttributeName: 'geometry',
      attributes: def.attributes.map((a) => {
        const resolved = resolvedAttribute(a, resolveClassId);
        return Object.fromEntries(REFERENCE_ATTRIBUTE_KEYS.filter((k) => resolved[k] !== undefined).map((k) => [k, resolved[k]]));
      }),
    })),
  };
}

const isEmpty = (value) => value === undefined || value === null || value === '';

const TYPE_CHECKS = {
  Integer: (v) => Number.isInteger(v),
  Decimal: (v) => typeof v === 'number' && Number.isFinite(v),
  Boolean: (v) => typeof v === 'boolean',
  Geospatial: (v) => Boolean(v) && typeof v === 'object' && typeof v.type === 'string' && Array.isArray(v.coordinates),
};
const ISO_ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;
const HAS_FRACTION = /T\d{2}:\d{2}:\d{2}\.\d/;

/** DataConnect DateTime: YYYY-MM-DDTHH:mm:ssZ (milliseconds are rejected); null when not a zoned instant. */
export function toDcDateTime(value) {
  let ms = NaN;
  if (typeof value === 'number') ms = value;
  else if (typeof value === 'string' && ISO_ZONED.test(value.trim())) ms = Date.parse(value.trim());
  if (!Number.isFinite(ms)) return null;
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

const typeMatches = (type, value) => (STRING_LIKE.has(type) ? typeof value === 'string' : (TYPE_CHECKS[type]?.(value) ?? true));

const relationshipTarget = (attr) => attr.relatedClassName
  ?? HISTORICAL_CLASSES.find((c) => c.id === attr.relatedClassId)?.className
  ?? LIVE_CLASS_NAMES.find((n) => placeholderObjectId(n) === attr.relatedClassId)
  ?? attr.relatedClassId;

const notFound = (attr) => ({
  attribute: attr.name, reasonCode: 'ValueNotFound',
  reason: `No records were found in the '${relationshipTarget(attr)}' Class on the 'Id' attribute with your value.`,
});

const attributeFailure = (attr, value, codesFor) => {
  if (attr.mandatory && isEmpty(value)) return { attribute: attr.name, reasonCode: 'Mandatory', reason: 'Mandatory attribute is missing' };
  if (!isEmpty(value) && !typeMatches(attr.type, value)) {
    return { attribute: attr.name, reasonCode: 'Type', reason: `Value does not match attribute type ${attr.type}` };
  }
  if (attr.type === 'DateTime' && typeof value === 'string' && HAS_FRACTION.test(value)) {
    return { attribute: attr.name, reasonCode: 'Type', reason: 'DateTime type cannot have milliseconds' };
  }
  if (!isRelationship(attr)) return null;
  // Real DataConnect treats an absent relationship key exactly like an empty one.
  if (isEmpty(value)) return notFound(attr);
  const codes = codesFor(attr);
  return codes instanceof Set && !codes.has(String(value)) ? notFound(attr) : null;
};

export function validateRecord(defOrDto, record, { codesFor = () => null } = {}) {
  const failures = [];
  for (const attr of defOrDto.attributes) {
    const failure = attributeFailure(attr, record?.[attr.name], codesFor);
    if (failure) failures.push(failure);
  }
  return { valid: failures.length === 0, failures };
}

export function unknownAttributes(defOrDto, record) {
  const names = new Set(defOrDto.attributes.map((a) => a.name));
  return Object.keys(record ?? {}).filter((k) => !names.has(k));
}

export function completeRecord(defOrDto, record) {
  const out = {};
  for (const [key, value] of Object.entries(record ?? {})) if (value !== null && value !== undefined) out[key] = value;
  // '' (not absence) so that merge-semantics Incremental loads overwrite a previously set value.
  for (const attr of defOrDto.attributes) {
    if (!attr.core && !isRelationship(attr) && STRING_LIKE.has(attr.type) && !(attr.name in out)) out[attr.name] = '';
  }
  return out;
}

export function fromCurated(item) {
  const record = { keyInSource: item.keyInSource, ...(item.attributes ?? {}) };
  if (isEmpty(record.code)) record.code = item.keyInSource;
  if (item.geoDetails?.source) record.geometry = item.geoDetails.source;
  return record;
}

export function comparableAttributes(record, { ignore = [] } = {}) {
  const skip = new Set(['keyInSource', 'geometry', ...ignore]);
  const out = {};
  for (const key of Object.keys(record ?? {}).sort()) {
    const value = record[key];
    if (skip.has(key) || isEmpty(value)) continue;
    // Real DataConnect reads a DateTime back as 2026-09-26T08:14:32.000+00:00.
    out[key] = typeof value === 'number' ? Math.round(value * 1e7) / 1e7
      : typeof value === 'string' && ISO_ZONED.test(value) ? toDcDateTime(value) ?? value : value;
  }
  return out;
}

const canonical = (value) => JSON.stringify(value, (_, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));

export function diffRecords(desired, current, { ignore = [] } = {}) {
  const currentByKey = new Map(current.map((r) => [r.keyInSource, r]));
  const seen = new Set();
  const upserts = [];
  let unchanged = 0;
  for (const record of desired) {
    if (seen.has(record.keyInSource)) throw new Error(`duplicate keyInSource '${record.keyInSource}' in desired records`);
    seen.add(record.keyInSource);
    const existing = currentByKey.get(record.keyInSource);
    const same = existing && canonical(comparableAttributes(record, { ignore })) === canonical(comparableAttributes(existing, { ignore }));
    if (same) unchanged += 1;
    else upserts.push(record);
  }
  return { upserts, unchanged };
}

const SEGMENT_CODE_SET = new Set(DC_SEGMENT_CODES);

export function dcSegmentCodeFor({ longitude, carriageway } = {}) {
  if (typeof longitude !== 'number' || !Number.isFinite(longitude)) return null;
  if (!Object.hasOwn(SEGMENT_CONFIG.suffixByCarriageway, carriageway ?? '')) return null;
  const band = SEGMENT_CONFIG.bands.find((b) => b.minLon <= longitude && longitude < b.maxLon);
  if (!band) return null;
  const code = band.number + SEGMENT_CONFIG.suffixByCarriageway[carriageway];
  return SEGMENT_CODE_SET.has(code) ? code : null;
}
