/**
 * The IFC Model Explorer's element index, built from what the Autodesk Viewer's property database
 * actually holds for the loaded model. Pure: no viewer, no DOM, so the same code is unit-tested
 * against a property dump and run in the page.
 *
 * Input is the Viewer's property result shape, `{dbId, name, externalId, properties: [{displayName,
 * displayValue, displayCategory, units, hidden}]}` (from `model.getBulkProperties` /
 * `getProperties`). Nothing is inferred beyond the categories below, which key off the IFC class
 * first and the model's own `NetworkRole` second. An element that fits none of them is "Other",
 * never forced into an equipment type.
 */

/** The IFC entity's own attributes. Other categories ("Contained In", "Port") carry other entities' GlobalIds. */
export const IFC_ATTRIBUTES = 'IFC Attributes';
/** Property sets that carry electrical attributes in these models. Shown first in the properties panel. */
export const isElectricalPset = category => /^SuperDNA_PowerNetwork$|^Pset_(Transformer|Switching|ProtectiveDevice|ElectricDistributionBoard|CableSegment|Electric|Light)/i.test(category ?? '');

/**
 * Equipment categories, in display order. `electrical` marks distribution equipment for the
 * explorer's counts; systems, spatial structure and ports are structure, not equipment.
 */
export const CATEGORIES = Object.freeze([
  { key: 'source', label: 'Utility intakes and standby sources', electrical: true,
    test: e => e.ifcClass === 'IfcElectricGenerator' || /^(Source|Standby source)$/i.test(e.networkRole ?? '') },
  { key: 'substation', label: 'Substations', electrical: true,
    test: e => /substation/i.test(e.networkRole ?? '') || (e.ifcClass === 'IfcElementAssembly' && /substation/i.test(e.name)) },
  { key: 'transformer', label: 'Transformers', electrical: true, test: e => e.ifcClass === 'IfcTransformer' },
  { key: 'switchgear', label: 'Switchgear, buses and switching stations', electrical: true,
    test: e => e.ifcClass === 'IfcElectricDistributionBoard' && (e.predefinedType === 'SWITCHBOARD' || /ring main|switchgear|switching station/i.test(e.networkRole ?? '')) },
  { key: 'breaker', label: 'Circuit breakers and switches', electrical: true,
    test: e => e.ifcClass === 'IfcProtectiveDevice' || e.ifcClass === 'IfcSwitchingDevice' },
  { key: 'cable', label: 'Feeders and cables', electrical: true,
    test: e => e.ifcClass === 'IfcCableSegment' && !/scada|fibre|fiber/i.test(e.networkRole ?? '') },
  { key: 'crane', label: 'Cranes and crane power', electrical: true,
    test: e => e.ifcClass === 'IfcTransportElement' || /crane/i.test(e.networkRole ?? '') },
  { key: 'load', label: 'Terminal equipment and loads', electrical: true,
    test: e => /^load$/i.test(e.networkRole ?? '') || e.ifcClass === 'IfcLightFixture' },
  { key: 'scada', label: 'SCADA and control', electrical: true,
    test: e => e.ifcClass === 'IfcController' || e.ifcClass === 'IfcCommunicationsAppliance' || /scada/i.test(e.networkRole ?? '') },
  { key: 'system', label: 'Distribution systems', electrical: false, test: e => e.ifcClass === 'IfcDistributionSystem' },
  { key: 'spatial', label: 'Project and site', electrical: false, test: e => /^Ifc(Project|Site|Building|BuildingStorey|Space)$/.test(e.ifcClass ?? '') },
  { key: 'port', label: 'Connection ports', electrical: false, test: e => e.ifcClass === 'IfcDistributionPort' },
  /** Body representations under an element (the shapes the viewer draws); a click on one selects its element. */
  { key: 'geometry', label: 'Geometry (body representations)', electrical: false,
    test: e => !e.globalId && /^Ifc\w*(Solid|Brep|Surface|Mesh|Shape|Curve)\w*$/.test(e.ifcClass ?? '') },
  /** Tree nodes the translator adds to group elements by class, and the file's root node. */
  { key: 'group', label: 'Tree grouping nodes', electrical: false, test: e => !e.globalId && !e.networkId },
  { key: 'other', label: 'Other elements', electrical: false, test: () => true },
]);
const CATEGORY = new Map(CATEGORIES.map(category => [category.key, category]));
export const categoryLabel = key => CATEGORY.get(key)?.label ?? key;

const text = value => (value === null || value === undefined ? '' : String(value).trim());

/** One property's value as the model states it, in a category (null when absent). Uncategorized = ''. */
export function propertyValue(result, category, name) {
  const prop = (result?.properties ?? []).find(p => (p.displayCategory || '') === (category || '') && p.displayName === name);
  return prop ? text(prop.displayValue) || null : null;
}

/** "IfcTransformer::TX-1 USS-1 transformer" → "TX-1 USS-1 transformer": the viewer's node names carry the class. */
const displayName = name => text(name).replace(/^Ifc[A-Za-z]+::/, '');

export function elementFromProperties(result) {
  const get = (category, name) => propertyValue(result, category, name);
  const net = 'SuperDNA_PowerNetwork';
  const element = {
    dbId: result.dbId,
    externalId: result.externalId ?? null,
    name: displayName(get('', 'Component Name') ?? result.name),
    nodeName: text(result.name),
    globalId: get(IFC_ATTRIBUTES, 'GlobalId'),
    ifcClass: get(IFC_ATTRIBUTES, 'IfcClass') ?? (/^(Ifc[A-Za-z]+)::/.exec(text(result.name))?.[1] ?? null),
    predefinedType: get(IFC_ATTRIBUTES, 'PredefinedType'),
    tag: get(IFC_ATTRIBUTES, 'Tag'),
    system: get(IFC_ATTRIBUTES, 'IfcSystem'),
    networkId: get(net, 'NetworkID'),
    networkRole: get(net, 'NetworkRole'),
    voltageLevel: get(net, 'VoltageLevel'),
    dataStatus: get(net, 'DataStatus'),
  };
  element.category = CATEGORIES.find(category => category.test(element)).key;
  element.electrical = CATEGORY.get(element.category).electrical;
  return element;
}

/** The index of a loaded model: every element with properties, by dbId, with category counts. */
export function buildIndex(results) {
  const elements = (results ?? []).filter(result => Number.isInteger(result?.dbId)).map(elementFromProperties);
  const counts = Object.fromEntries(CATEGORIES.map(category => [category.key, 0]));
  for (const element of elements) counts[element.category] += 1;
  return {
    elements,
    byDbId: new Map(elements.map(element => [element.dbId, element])),
    counts,
    electricalCount: elements.filter(element => element.electrical).length,
    withGlobalId: elements.filter(element => element.globalId).length,
  };
}

/**
 * Search by name, IFC GlobalId, IFC class, Tag, network id or role. Every term must match
 * (case-insensitive), so "transformer 13.8" narrows. Ports are left out unless asked for by class.
 */
export function searchElements(index, query, { limit = 200, includePorts = false } = {}) {
  const terms = text(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const wantsPorts = includePorts || terms.some(term => term.includes('port'));
  const hits = [];
  for (const element of index.elements) {
    if (element.category === 'port' && !wantsPorts) continue;
    const haystack = [element.name, element.globalId, element.ifcClass, element.predefinedType, element.tag, element.networkId,
      element.networkRole, element.voltageLevel, element.system, String(element.dbId)].join(' ').toLowerCase();
    if (terms.every(term => haystack.includes(term))) hits.push(element);
    if (hits.length >= limit) break;
  }
  return hits;
}

/** The elements of one category, sorted by name, for the category browser. */
export function elementsIn(index, key) {
  return index.elements.filter(element => element.category === key).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/**
 * Properties grouped by the model's own categories, hidden ones dropped, values as stated. The
 * electrical property sets come first, then IFC Attributes, then the rest in model order.
 */
export function groupProperties(result) {
  const groups = new Map();
  for (const prop of result?.properties ?? []) {
    if (prop.hidden) continue;
    const category = text(prop.displayCategory) || 'General';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push({ name: text(prop.displayName), value: text(prop.displayValue), units: text(prop.units) || null });
  }
  const rank = category => (isElectricalPset(category) ? 0 : category === IFC_ATTRIBUTES ? 1 : 2);
  return [...groups].map(([category, props]) => ({ category, electrical: isElectricalPset(category), props }))
    .sort((a, b) => rank(a.category) - rank(b.category));
}

/** Every property category in the model, with how many nodes carry it, in descending order. */
export function propertyCategories(results) {
  const counts = new Map();
  for (const result of results ?? []) {
    for (const category of new Set((result.properties ?? []).filter(p => !p.hidden).map(p => text(p.displayCategory) || 'General'))) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  return [...counts].map(([category, count]) => ({ category, count, electrical: isElectricalPset(category) })).sort((a, b) => b.count - a.count);
}

const UNIT_SYMBOLS = { volts: 'V', kilovolts: 'kV', watts: 'W', kilowatts: 'kW', voltAmperes: 'VA', kilovoltAmperes: 'kVA', amperes: 'A',
  meters: 'm', millimeters: 'mm', centimeters: 'cm', squareMeters: 'm²', cubicMeters: 'm³', degrees: '°', celsius: '°C', hertz: 'Hz', kilograms: 'kg' };
/**
 * The viewer reports units as Forge type ids ("autodesk.unit.unit:volts-2.0.0"). Only the label is
 * shortened; the value is shown as the model states it. An unknown unit keeps its own name.
 */
export function unitLabel(units) {
  const name = /unit:([A-Za-z]+)/.exec(String(units ?? ''))?.[1];
  return name ? UNIT_SYMBOLS[name] ?? name : String(units ?? '');
}
