import { Color, Event, Material } from 'cesium';
import { corridorVisualConfig as config } from './corridorVisualConfig.js';
const TYPE = 'I595DirectionalFlow';
// One shader on each existing segment; screen-space chevrons do not add map entities.
if (!Material._materialCache.getMaterial(TYPE)) Material._materialCache.addMaterial(TYPE, {
  fabric: { type: TYPE, uniforms: { color: Color.CYAN, phase: 0, direction: 1, arrows: 1, casing: 0.18, spacing: 90 }, source: `
  czm_material czm_getMaterial(czm_materialInput materialInput) {
    czm_material m = czm_getDefaultMaterial(materialInput);
    float edge = abs(materialInput.st.t - 0.5) * 2.0;
    float inner = 1.0 - smoothstep(1.0-casing-0.04, 1.0-casing, edge);
    float pixelLength = 1.0 / max(fwidth(materialInput.st.s), 0.000001);
    float travel = materialInput.st.s * pixelLength / spacing * direction - phase;
    float chevron = 1.0-smoothstep(0.06,0.12,abs(fract(travel + abs(materialInput.st.t-0.5)*0.65)-0.5));
    vec3 ink = mix(color.rgb, vec3(0.88,1.0,0.98), chevron*arrows*0.78);
    m.diffuse = mix(vec3(0.025,0.06,0.10),ink,inner);
    m.alpha = color.a * mix(0.8,1.0,inner);
    return m;
  }` }, translucent: () => true,
});
export class TrafficFlowMaterial {
  constructor(direction = 1) {
    this.definitionChanged = new Event(); this.isConstant = false;
    this.tint = Color.CYAN; this.direction = direction; this.speed = .22; this.arrows = false;
    this.width = 8; this.phase = 0; this.last = performance.now();
  }
  getType() { return TYPE; }
  getValue(_time, result = {}) {
    const now = performance.now();
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches && this.arrows) this.phase += Math.min(0.1,(now-this.last)/1000)*this.speed;
    this.last=now;
    result.color=Color.clone(this.tint,result.color); result.phase=this.phase%1000;
    result.direction=this.direction; result.arrows=this.arrows?1:0;
    result.casing=config.casing.enabled?config.casing.pixels/(this.width+config.casing.pixels):0;
    result.spacing=config.arrow.spacingPixels;return result;
  }
  equals(other) { return this===other; }
}
