/**
 * Ready-made questions, built against the equipment that actually exists.
 *
 * A preset fills the form; it never runs. Every asset it names is resolved from the inventory at
 * the moment it is offered, so a preset can never point at a part that is not on this gantry — and
 * a preset whose equipment is absent is not offered at all rather than failing when chosen.
 *
 * Where there is a choice, the preset prefers a part whose baseline is operational: "suppose this
 * working antenna failed" is the question people mean, and simulating the failure of something
 * already failed answers very little.
 */
import { addFailure, createScenario, withDetails } from './scenarioState.js';

const pick = (inventory, type, { skip = [] } = {}) => {
  const candidates = inventory.filter(asset => asset.type === type && !skip.includes(asset.assetId));
  return candidates.find(asset => asset.operationalStatus === 'OPERATIONAL') ?? candidates[0] ?? null;
};

/**
 * @typedef {{id: string, label: string, description: string,
 *   build: (inventory: object[], options: object) => object|null}} Preset
 */
export const PRESETS = Object.freeze([
  Object.freeze({
    id: 'rfid-single', label: 'Single RFID antenna failure',
    description: 'One transponder reader stops reading.',
    build: (inventory, options) => one(inventory, 'RFID_ANTENNA', 'COMPLETE_FAILURE', options),
  }),
  Object.freeze({
    id: 'ves-single', label: 'Single VES camera failure',
    description: 'One video enforcement camera stops capturing.',
    build: (inventory, options) => one(inventory, 'VES_CAMERA', 'COMPLETE_FAILURE', options),
  }),
  Object.freeze({
    id: 'cctv-single', label: 'Single CCTV camera failure',
    description: 'One surveillance camera goes offline.',
    build: (inventory, options) => one(inventory, 'CCTV_CAMERA', 'COMPLETE_FAILURE', options),
  }),
  Object.freeze({
    id: 'sign-single', label: 'Digital toll sign failure',
    description: 'A digital sign stops displaying.',
    build: (inventory, options) => one(inventory, 'DIGITAL_SIGN', 'COMPLETE_FAILURE', options),
  }),
  Object.freeze({
    id: 'multiple', label: 'Multiple equipment failures',
    description: 'An antenna and a camera out at the same time.',
    build: (inventory, options) => {
      const antenna = pick(inventory, 'RFID_ANTENNA');
      const camera = pick(inventory, 'VES_CAMERA');
      if (!antenna || !camera) return null;
      let scenario = base(options, 'Multiple equipment failures');
      scenario = addFailure(scenario, { assetId: antenna.assetId, failureMode: 'COMPLETE_FAILURE' });
      return addFailure(scenario, { assetId: camera.assetId, failureMode: 'COMPLETE_FAILURE' });
    },
  }),
  Object.freeze({
    id: 'rfid-intermittent', label: 'Intermittent RFID antenna',
    description: 'A reader that works only part of the time.',
    build: (inventory, options) => one(inventory, 'RFID_ANTENNA', 'INTERMITTENT_FAILURE', options,
      { availabilityPercent: 60 }),
  }),
  Object.freeze({
    id: 'camera-degraded', label: 'Degraded camera performance',
    description: 'A camera still capturing, at reduced effectiveness.',
    build: (inventory, options) => one(inventory, 'VES_CAMERA', 'DEGRADED_PERFORMANCE', options,
      { performancePercent: 70 }),
  }),
]);

const base = (options, name) => withDetails(createScenario({ ...options }), { name });

function one(inventory, type, failureMode, options, parameters = {}) {
  const asset = pick(inventory, type);
  if (!asset) return null;
  const scenario = base(options,
    `${failureMode === 'COMPLETE_FAILURE' ? 'Failure' : 'Fault'}: ${asset.name ?? asset.assetId}`);
  return addFailure(scenario, { assetId: asset.assetId, failureMode, ...parameters });
}

/** The presets that can be built from this inventory, each already filled in. */
export function availablePresets(inventory = [], options = {}) {
  return PRESETS
    .map(preset => ({ ...preset, scenario: preset.build(inventory, options) }))
    .filter(preset => preset.scenario);
}
