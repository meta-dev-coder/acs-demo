export const corridorVisualConfig = {
  lod: { overviewDistance: 14000, corridorDistance: 5000, infrastructureDistance: 1600, hysteresis: 0.08 },
  lineWidth: { overview: 5, corridor: 8, infrastructure: 12, detail: 14 },
  casing: { enabled: true, pixels: 4, color: '#071322', alpha: 0.78 },
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
  return ({FREE_FLOW:'#55d6ba',MODERATE:'#e5bc57',HEAVY:'#ee9148',CONGESTED:'#e66259',SEVERE:'#b93c51',STOPPED:'#b93c51'})[getTrafficState(status)] ?? (direction === 'EB' ? '#52cddd' : '#a3a9ec');
}
export function getFlowAnimationSpeed(status, speed = status?.speedMph) {
  if (Number.isFinite(speed)) return Math.max(0.01, Math.min(1.2, speed / 70));
  return ({FREE_FLOW:1,MODERATE:.65,HEAVY:.35,CONGESTED:.14,SEVERE:.07,STOPPED:.01})[getTrafficState(status)] ?? corridorVisualConfig.arrow.unknownSpeed;
}
