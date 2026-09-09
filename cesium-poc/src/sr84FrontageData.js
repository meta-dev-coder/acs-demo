/**
 * @typedef {'EB'|'WB'} FrontageRoadDirection
 * @typedef {object} FrontageRoadFeature
 * @property {string} road
 * @property {'frontage_road'} facility
 * @property {FrontageRoadDirection} direction
 * @property {string} corridor
 * @property {string} source
 */
export const FRONTAGE_DIRECTIONS = [
  { direction: 'EB', id: 'SR84_EB', label: 'SR 84 Eastbound', color: '#55bda8' },
  { direction: 'WB', id: 'SR84_WB', label: 'SR 84 Westbound', color: '#719ddd' },
];
export const frontageName = road => FRONTAGE_DIRECTIONS.find(item => item.direction === road.direction)?.label || 'SR 84';

/** @returns {FrontageRoadFeature} */
export function frontageFromProperties(properties) {
  if (!FRONTAGE_DIRECTIONS.some(item => item.direction === properties.direction)) throw new Error('Unknown frontage-road direction.');
  return {
    road: properties.road || 'Unknown', facility: properties.facility,
    direction: properties.direction, corridor: properties.corridor || 'Unknown', source: properties.source || 'Unknown',
  };
}
export function frontageDetails(road) {
  return [
    ['Road', road.road], ['Facility', road.facility === 'frontage_road' ? 'Frontage Road' : 'Unknown'],
    ['Direction', road.direction === 'EB' ? 'Eastbound' : 'Westbound'], ['Corridor', road.corridor],
    ['Source', road.source === 'OpenStreetMap / Overpass' ? 'OpenStreetMap' : road.source],
  ];
}
