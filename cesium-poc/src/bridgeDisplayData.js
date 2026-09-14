// Suppress only L records with an exact R counterpart on the same roadway.
// Retain the original features and coordinates; side codes do not imply EB/WB.
export function bridgesForDisplay(features) {
  const key = feature => {
    const coordinates = feature.geometry.coordinates;
    const forward = JSON.stringify(coordinates);
    const reverse = JSON.stringify([...coordinates].reverse());
    return JSON.stringify([feature.properties.roadway, forward < reverse ? forward : reverse]);
  };
  const rightLocations = new Set(features.filter(f => f.properties.road_side === 'R').map(key));
  return features.filter(f => f.properties.road_side !== 'L' || !rightLocations.has(key(f)));
}
