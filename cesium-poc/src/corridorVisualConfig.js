/**
 * Road CATEGORY styling — one place, so the corridor reads as a cartographic palette rather than a
 * set of independently-chosen highlights.
 *
 * These are category colours, not condition colours. Traffic state, incidents and closures keep
 * their own semantics below and are untouched by this: a road is coloured by what it IS here, and
 * by what is HAPPENING to it there.
 *
 * Deliberately muted and translucent. Google's photogrammetry is the dominant layer and the
 * pavement underneath has to stay visible — these are overlays on an aerial, not painted ribbons.
 * They do not follow the light/dark UI theme, because the imagery they sit on does not change.
 */
export const ROAD_STYLE = Object.freeze({
  // I-595 general purpose — the corridor's identity. Both carriageways share one blue: direction is
  // already carried by the animated flow arrows, and two hues here made the corridor read as two
  // datasets rather than one road.
  generalPurposeEB: Object.freeze({ color: '#2878D0', opacity: 0.68 }),
  generalPurposeWB: Object.freeze({ color: '#2878D0', opacity: 0.68 }),
  // Managed lanes: a lighter step of the same blue, so Express reads as part of I-595 rather than
  // as a warning. Operational amber/red stays available for actual conditions.
  managed: Object.freeze({ color: '#4C8FD8', opacity: 0.64 }),
  // Frontage roads lean teal to separate them from the mainline while staying in the family.
  frontageEB: Object.freeze({ color: '#4F9A98', opacity: 0.52 }),
  frontageWB: Object.freeze({ color: '#4F9A98', opacity: 0.52 }),
  /**
   * Ramps stay subordinate: a quiet blue-gray, with the five FDOT classes kept as small steps
   * inside that band so the data's own categories survive without competing with the corridor.
   */
  ramp: Object.freeze({ color: '#7196B5', opacity: 0.46 }),
  rampByType: Object.freeze({
    ENTRY_RAMP: '#6F9BB8',
    EXIT_RAMP: '#7A93AF',
    INTERCHANGE_RAMP: '#7196B5',
    INTERCHANGE_CONNECTOR: '#6B8FB4',
    EXPRESS_CONNECTOR: '#789EC0',
  }),
  reference: Object.freeze({ color: '#8FA5B5', opacity: 0.40 }),
  /** Selection deepens the corridor blue rather than lightening or recolouring it. */
  selected: Object.freeze({ color: '#1261B5', opacity: 0.88 }),
  hoverOpacity: 0.70,
});

export const corridorVisualConfig = {
  lod: { overviewDistance: 14000, corridorDistance: 5000, infrastructureDistance: 1600, hysteresis: 0.08 },
  lineWidth: { overview: 5, corridor: 8, infrastructure: 12, detail: 14 },
  // No dark boundary: an outline made the overlays read as vector shapes pasted onto the aerial.
  // The ribbon separates by colour and opacity alone, which is what keeps Google's pavement visible.
  casing: { enabled: false, pixels: 0, color: '#1B2A38', alpha: 0 },
  arrow: { enabled: true, spacingPixels: 90, unknownSpeed: 0.22 },
  animation: { initialFlyInMs: 1800, fadeMs: 180, focusMs: 700 },
  weatherImpact: { heavyRainMmHour: 7.5, strongWindKmh: 40 },
};
export function corridorLOD(distance) {
  const l = corridorVisualConfig.lod;
  return distance > l.overviewDistance ? 'overview' : distance > l.corridorDistance ? 'corridor' : distance > l.infrastructureDistance ? 'infrastructure' : 'detail';
}
export function getTrafficState(status) {
  if (status?.closureState === 'CLOSED') return 'STOPPED';
  const state = status?.congestionLevel;
  return ['FREE_FLOW','MODERATE','HEAVY','CONGESTED','SEVERE','STOPPED'].includes(state) ? state : 'UNKNOWN';
}
export function getTrafficColor(status, direction) {
  // Traffic-condition colours are semantic and unchanged. Only the no-status fallback becomes the
  // road's category colour, which is what it always meant.
  return ({FREE_FLOW:'#55d6ba',MODERATE:'#e5bc57',HEAVY:'#ee9148',CONGESTED:'#e66259',SEVERE:'#b93c51',STOPPED:'#b93c51'})[getTrafficState(status)]
    ?? (direction === 'EB' ? ROAD_STYLE.generalPurposeEB.color : ROAD_STYLE.generalPurposeWB.color);
}
export function getFlowAnimationSpeed(status, speed = status?.speedMph) {
  if (Number.isFinite(speed)) return Math.max(0.01, Math.min(1.2, speed / 70));
  return ({FREE_FLOW:1,MODERATE:.65,HEAVY:.35,CONGESTED:.14,SEVERE:.07,STOPPED:.01})[getTrafficState(status)] ?? corridorVisualConfig.arrow.unknownSpeed;
}
