/**
 * Lightweight atmospheric effects drawn over the Cesium canvas.
 *
 * These effects illustrate the historical weather bucket selected in Safety. They deliberately
 * live in a screen-space canvas instead of Cesium entities: rain and haze belong to the camera,
 * should not move across the ground as the camera flies, and must never intercept a map click.
 */

export const WEATHER_EFFECT_PRESETS = Object.freeze({
  Humid: Object.freeze({ kind: 'mist', particles: 16, tint: 'rgba(205, 225, 226, .13)' }),
  Windy: Object.freeze({ kind: 'wind', particles: 70, tint: 'rgba(185, 205, 215, .055)' }),
  Overcast: Object.freeze({ kind: 'cloud', particles: 12, tint: 'rgba(45, 57, 73, .22)' }),
  'Light Rain': Object.freeze({ kind: 'rain', particles: 105, speed: 0.72, tint: 'rgba(35, 55, 76, .13)' }),
  Rain: Object.freeze({ kind: 'rain', particles: 245, speed: 1.25, tint: 'rgba(20, 36, 56, .25)' }),
});

const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const random = (min, max) => min + Math.random() * (max - min);

/** @param {HTMLElement} host */
export function installWeatherEffects(host = document.body) {
  const canvas = document.createElement('canvas');
  canvas.className = 'safety-weather-effect';
  canvas.hidden = true;
  canvas.setAttribute('aria-hidden', 'true');
  host.append(canvas);

  const context = canvas.getContext('2d');
  let condition = null;
  let preset = null;
  let particles = [];
  let frame = 0;
  let lastTime = 0;
  let width = 0;
  let height = 0;

  function size() {
    const bounds = host === document.body
      ? { width: innerWidth, height: innerHeight }
      : host.getBoundingClientRect();
    width = Math.max(1, Math.round(bounds.width));
    height = Math.max(1, Math.round(bounds.height));
    const ratio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (preset) makeParticles();
  }

  function rainDrop(anywhere = true) {
    return {
      x: random(-width * .1, width * 1.05), y: anywhere ? random(-height, height) : random(-height * .25, -10),
      length: random(condition === 'Rain' ? 18 : 10, condition === 'Rain' ? 38 : 23),
      speed: random(620, 1040) * preset.speed, drift: random(90, 155), alpha: random(.25, .72),
    };
  }

  function makeParticles() {
    if (!preset) return;
    if (preset.kind === 'rain') particles = Array.from({ length: preset.particles }, () => rainDrop());
    else if (preset.kind === 'wind') particles = Array.from({ length: preset.particles }, () => ({
      x: random(-width, width), y: random(0, height), length: random(22, 72),
      speed: random(250, 600), alpha: random(.08, .3), wave: random(0, Math.PI * 2),
    }));
    else particles = Array.from({ length: preset.particles }, (_, index) => ({
      x: random(-width * .3, width), y: random(-height * .15, height * .9),
      radius: preset.kind === 'cloud' ? random(160, 360) : random(100, 260),
      speed: random(4, 13), alpha: random(.035, .11), phase: index,
    }));
  }

  function background() {
    context.fillStyle = preset.tint;
    context.fillRect(0, 0, width, height);
  }

  function drawRain(dt) {
    context.lineWidth = condition === 'Rain' ? 1.35 : .9;
    context.lineCap = 'round';
    for (let index = 0; index < particles.length; index += 1) {
      const drop = particles[index];
      drop.x += drop.drift * dt;
      drop.y += drop.speed * dt;
      if (drop.y - drop.length > height || drop.x > width + 30) particles[index] = rainDrop(false);
      const current = particles[index];
      context.strokeStyle = `rgba(195, 224, 255, ${current.alpha})`;
      context.beginPath();
      context.moveTo(current.x, current.y);
      context.lineTo(current.x - current.length * .22, current.y - current.length);
      context.stroke();
    }
  }

  function drawWind(dt, elapsed) {
    context.lineWidth = 1.2;
    context.lineCap = 'round';
    for (const streak of particles) {
      streak.x += streak.speed * dt;
      const y = streak.y + Math.sin(elapsed * .002 + streak.wave) * 8;
      if (streak.x - streak.length > width) { streak.x = random(-180, -20); streak.y = random(0, height); }
      const gradient = context.createLinearGradient(streak.x - streak.length, y, streak.x, y);
      gradient.addColorStop(0, 'rgba(225,240,245,0)');
      gradient.addColorStop(1, `rgba(225,240,245,${streak.alpha})`);
      context.strokeStyle = gradient;
      context.beginPath(); context.moveTo(streak.x - streak.length, y + 5); context.lineTo(streak.x, y); context.stroke();
    }
  }

  function drawAtmosphere(dt, elapsed) {
    for (const cloud of particles) {
      cloud.x += cloud.speed * dt;
      if (cloud.x - cloud.radius > width) cloud.x = -cloud.radius;
      const y = cloud.y + Math.sin(elapsed * .00025 + cloud.phase) * 16;
      const gradient = context.createRadialGradient(cloud.x, y, 0, cloud.x, y, cloud.radius);
      const color = preset.kind === 'cloud' ? '45,55,70' : '220,235,232';
      gradient.addColorStop(0, `rgba(${color},${cloud.alpha})`);
      gradient.addColorStop(.58, `rgba(${color},${cloud.alpha * .55})`);
      gradient.addColorStop(1, `rgba(${color},0)`);
      context.fillStyle = gradient;
      context.beginPath();
      context.ellipse(cloud.x, y, cloud.radius, cloud.radius * .42, 0, 0, Math.PI * 2);
      context.fill();
    }
  }

  function paintStatic() {
    context.clearRect(0, 0, width, height);
    background();
    if (preset.kind === 'mist' || preset.kind === 'cloud') drawAtmosphere(0, 0);
  }

  function animate(now) {
    if (!preset || document.hidden || reducedMotion()) { frame = 0; return; }
    const dt = Math.min(.04, (now - (lastTime || now)) / 1000);
    lastTime = now;
    context.clearRect(0, 0, width, height);
    background();
    if (preset.kind === 'rain') drawRain(dt);
    else if (preset.kind === 'wind') drawWind(dt, now);
    else drawAtmosphere(dt, now);
    frame = requestAnimationFrame(animate);
  }

  function stopFrame() { if (frame) cancelAnimationFrame(frame); frame = 0; lastTime = 0; }
  function startFrame() {
    stopFrame();
    if (reducedMotion()) paintStatic();
    else if (!document.hidden) frame = requestAnimationFrame(animate);
  }

  function setCondition(next) {
    const nextPreset = WEATHER_EFFECT_PRESETS[next] ?? null;
    if (!nextPreset) { clear(); return false; }
    condition = next;
    preset = nextPreset;
    canvas.dataset.condition = nextPreset.kind;
    canvas.hidden = false;
    size();
    startFrame();
    return true;
  }

  function clear() {
    stopFrame(); condition = null; preset = null; particles = [];
    canvas.hidden = true; delete canvas.dataset.condition;
    context.clearRect(0, 0, width, height);
  }

  function onVisibility() { if (document.hidden) stopFrame(); else if (preset) startFrame(); }
  const resize = new ResizeObserver(size);
  resize.observe(host === document.body ? document.documentElement : host);
  document.addEventListener('visibilitychange', onVisibility);
  size();

  return {
    setCondition, clear,
    get condition() { return condition; },
    destroy() { clear(); resize.disconnect(); document.removeEventListener('visibilitychange', onVisibility); canvas.remove(); },
  };
}
