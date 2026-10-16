/**
 * The two gantry datasets the Tolling screen browses, read into one shape.
 *
 * They are genuinely different things and are kept apart everywhere downstream:
 *
 *   • TOLL — OpenStreetMap toll gantries (`highway=toll_gantry`). Published tolling attributes:
 *     who operates it, what SunPass is charged, which transponders it accepts. ODbL.
 *   • EXPRESS — the 595 Express access nodes and ORT mainline gantries already shipped with the
 *     app, from FDOT / 595 Express Operations. These carry lane counts, direction and a DMS
 *     message, and say nothing about a toll charge.
 *
 * Nothing is merged, defaulted or inferred: a field a dataset does not publish stays null, and a
 * record never borrows an attribute from the other set because the two sit near each other.
 *
 * Pure: GeoJSON in, records out, no Cesium and no DOM.
 */

/** The two corpora, used as a record's `kind` and as the cards' keys. */
export const GANTRY_KINDS = Object.freeze({ TOLL: 'TOLL', EXPRESS: 'EXPRESS' });

/** ODbL requires attribution wherever the data is shown. */
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors, ODbL';
/** Where the express gantries come from — the app's existing label for them. */
export const EXPRESS_SOURCE = 'FDOT / 595 Express Operations';

const text = value => {
  const string = String(value ?? '').trim();
  return string && string.toUpperCase() !== 'N/A' ? string : null;
};
const point = feature => (feature?.geometry?.type === 'Point' && Array.isArray(feature.geometry.coordinates)
  ? feature.geometry.coordinates : null);

/** A tag counts only when the source actually says yes — never defaulted. */
const accepts = (properties, key) => String(properties?.[`payment:${key}`] ?? '').toLowerCase() === 'yes';

/** The payment methods a node declares, in the order an operator would read them. */
export function paymentMethods(properties) {
  const known = [
    ['sunpass', 'SunPass'], ['e_zpass', 'E-ZPass'], ['peach_pass', 'Peach Pass'],
    ['nc_quick_pass', 'NC Quick Pass'], ['leeway', 'Leeway'], ['license_plate', 'Toll-by-plate'],
  ];
  return known.filter(([key]) => accepts(properties, key)).map(([, label]) => label);
}

/**
 * OSM toll gantries.
 *
 * The name is built from what the node publishes. An unnamed gantry is "Toll gantry", not a name
 * invented from the road it happens to stand over.
 */
export function tollGantryRecords(geojson) {
  return (geojson?.features ?? [])
    .filter(feature => feature?.properties?.highway === 'toll_gantry' && point(feature))
    .map(feature => {
      const properties = feature.properties ?? {};
      const [longitude, latitude] = point(feature);
      const operator = text(properties.operator);
      return Object.freeze({
        id: String(feature.id ?? properties['@id'] ?? `${longitude},${latitude}`),
        kind: GANTRY_KINDS.TOLL,
        name: text(properties.name) ?? (operator ? `Toll gantry — ${operator}` : 'Toll gantry'),
        longitude,
        latitude,
        operator,
        /** The node's own `charge:sunpass`, verbatim and with its currency. */
        sunpassCharge: text(properties['charge:sunpass']),
        payments: Object.freeze(paymentMethods(properties)),
        attribution: OSM_ATTRIBUTION,
        properties: Object.freeze({ ...properties }),
      });
    });
}

/** The 595 Express gantries the app already ships. */
export function expressGantryRecords(geojson) {
  return (geojson?.features ?? [])
    .filter(feature => text(feature?.properties?.gantry_id) && point(feature))
    .map(feature => {
      const properties = feature.properties ?? {};
      const [longitude, latitude] = point(feature);
      return Object.freeze({
        id: String(properties.gantry_id),
        kind: GANTRY_KINDS.EXPRESS,
        name: text(properties.name) ?? String(properties.gantry_id),
        longitude,
        latitude,
        /** 'access_node' or 'ort_mainline' — an access point is not a mainline reader. */
        gantryType: text(properties.type),
        milepost: Number.isFinite(Number(properties.milepost)) ? Number(properties.milepost) : null,
        direction: text(properties.direction),
        laneCount: Number.isFinite(Number(properties.lane_count)) ? Number(properties.lane_count) : null,
        status: text(properties.status),
        dmsText: text(properties.dms_text),
        attribution: EXPRESS_SOURCE,
        properties: Object.freeze({ ...properties }),
      });
    });
}
