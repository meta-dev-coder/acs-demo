/**
 * An animated, directional flow line for Cesium polylines (ground-clamped ones included).
 *
 * The material draws a soft glowing core with chevrons (">") that travel from the start of the
 * polyline to its end. Direction is therefore the drawing order: the layer draws every link from
 * its supplying asset to the asset it supplies, and only on links whose conductors the engine
 * computed as energized. Speed and spacing are uniforms, so a frozen line (reduced motion) is the
 * same material with speed 0. Time comes from `czm_frameNumber` inside the shader: no per-frame
 * JavaScript and no per-frame property updates.
 *
 * It shows schematic connectivity — that a path is live and which way it feeds — not current
 * magnitude: every live link moves at the same speed.
 */
import { Color, Event, Material } from 'cesium';

export const FLOW_TYPE = 'SeagirtFlow';

const SOURCE = `
uniform vec4 color;
uniform float speed;
uniform float repeat;
czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);
  vec2 st = materialInput.st;
  float across = abs(st.t - 0.5) * 2.0;                 // 0 on the centre line, 1 at the edge
  float phase = fract(st.s * repeat - czm_frameNumber * speed + across * 0.45);
  float chevron = smoothstep(0.0, 0.06, phase) * (1.0 - smoothstep(0.2, 0.3, phase));
  float core = 1.0 - smoothstep(0.18, 0.62, across);   // the bright line
  float glow = 1.0 - smoothstep(0.35, 1.0, across);    // the soft halo around it
  float body = max(core, glow * 0.38);
  float head = chevron * (1.0 - smoothstep(0.55, 0.9, across));
  material.diffuse = mix(color.rgb, vec3(1.0), head * 0.55 + core * 0.15);
  material.emission = color.rgb * (0.25 + head * 0.6);
  material.alpha = color.a * clamp(body * 0.8 + head * 0.7, 0.0, 1.0);
  return material;
}`;

let registered = false;
function register() {
  if (registered) return;
  registered = true;
  // The public way to add a fabric type to Cesium's cache; used by most custom polyline materials.
  Material._materialCache.addMaterial(FLOW_TYPE, {
    fabric: { type: FLOW_TYPE, uniforms: { color: Color.WHITE, speed: 0.012, repeat: 8 }, source: SOURCE },
    translucent: () => true,
  });
}

/** A constant MaterialProperty: built once per link and colour, never per frame. */
export class FlowMaterialProperty {
  constructor({ color, speed = 0.012, repeat = 8 }) {
    register();
    this.color = color;
    this.speed = speed;
    this.repeat = repeat;
    this.definitionChanged = new Event();
  }
  get isConstant() { return true; }
  getType() { return FLOW_TYPE; }
  getValue(time, result = {}) {
    result.color = Color.clone(this.color, result.color);
    result.speed = this.speed;
    result.repeat = this.repeat;
    return result;
  }
  equals(other) {
    return this === other || (other instanceof FlowMaterialProperty && Color.equals(this.color, other.color)
      && this.speed === other.speed && this.repeat === other.repeat);
  }
}
