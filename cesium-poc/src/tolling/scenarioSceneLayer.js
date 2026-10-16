/**
 * What a weather or incident scenario looks like on the map.
 *
 * Deliberately almost nothing: a chip saying which synthetic conditions are in force, and one
 * marker for a hypothetical incident. No rain particles, no vehicles, no painted lane closures.
 *
 * Two reasons. The scene is photorealistic tiles plus a 76 MB mesh, and a particle system over
 * that buys a frame rate problem for no information. And a crash drawn convincingly on a real
 * roadway reads as a thing that happened: the marker is labelled HYPOTHETICAL, placed at a stated
 * offset from the gantry rather than at an invented point on a carriageway, and it says so when
 * you hover it.
 */
import { Cartesian2, Cartesian3, Color, CustomDataSource, HeightReference, LabelStyle,
  VerticalOrigin } from 'cesium';

/** How far upstream of the gantry a synthetic incident is drawn, in metres. */
const UPSTREAM_M = 180;

const incidentIcon = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 32 32">
    <circle cx="16" cy="16" r="13" fill="#0b1729" stroke="#f59e0b" stroke-width="3"/>
    <path d="M16 8v10" stroke="#f59e0b" stroke-width="3" stroke-linecap="round"/>
    <circle cx="16" cy="23" r="1.8" fill="#f59e0b"/>
  </svg>`)}`;

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{anchor: () => {longitude: number, latitude: number}|null}} deps the gantry to offset from
 */
export function installScenarioSceneLayer(viewer, { anchor } = {}) {
  const source = new CustomDataSource('I-595 Scenario Conditions');
  const added = viewer ? viewer.dataSources.add(source) : Promise.resolve();
  let marker = null;

  /** The incident's drawn position: a stated offset from the gantry, not a surveyed location. */
  function positionFor() {
    const point = anchor?.();
    if (!point) return null;
    // Due west of the gantry, upstream of the eastbound carriageway. An approximation, and the
    // label says the location is hypothetical.
    const metresPerDegree = 111_320 * Math.cos((point.latitude * Math.PI) / 180);
    return Cartesian3.fromDegrees(point.longitude - UPSTREAM_M / metresPerDegree, point.latitude);
  }

  return {
    whenReady: () => added,
    /** Draw the incident, or clear it when the scenario has none. */
    setIncident(incident) {
      if (marker) { source.entities.remove(marker); marker = null; }
      const position = incident ? positionFor() : null;
      if (!position) { viewer?.scene?.requestRender?.(); return false; }
      marker = source.entities.add({
        position,
        billboard: {
          image: incidentIcon, width: 30, height: 30, verticalOrigin: VerticalOrigin.BOTTOM,
          heightReference: HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: `${incident.label ?? incident.type} · hypothetical`,
          font: '500 13px system-ui, sans-serif',
          fillColor: Color.fromCssColorString('#f8d9a0'),
          outlineColor: Color.fromCssColorString('#0b1729'), outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: VerticalOrigin.BOTTOM,
          pixelOffset: new Cartesian2(0, -34),
          heightReference: HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        description: 'Synthetic incident scenario. Not a recorded FL511 event, and its position is '
          + `a demonstration offset ${UPSTREAM_M} m upstream of the gantry.`,
      });
      viewer?.scene?.requestRender?.();
      return true;
    },
    /** Where the incident marker is, for a camera that wants to look at it. */
    incidentPosition: () => marker?.position?.getValue(viewer?.clock?.currentTime) ?? null,
    clear() { if (marker) { source.entities.remove(marker); marker = null; viewer?.scene?.requestRender?.(); } },
    destroy() { viewer?.dataSources?.remove(source, true); },
  };
}
